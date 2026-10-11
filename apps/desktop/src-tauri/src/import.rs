//! Background import: scan folders, read metadata in parallel, insert into the
//! catalog, restore XMP sidecars, then build thumbnails.

use crate::db::{self, PhotoMeta};
use crate::decode::format_for_path;
use crate::error::AppResult;
use crate::state::AppState;
use crate::{metadata, thumbs, xmp};
use rayon::prelude::*;
use serde::Serialize;
use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub missing: usize,
    pub errors: Vec<String>,
    pub thumbnails: usize,
}

pub struct Candidate {
    pub path: PathBuf,
    pub root: PathBuf,
    pub format: &'static str,
}

fn hidden(p: &Path) -> bool {
    p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false)
}

pub fn scan(paths: &[PathBuf]) -> Vec<Candidate> {
    let mut out = vec![];
    for p in paths {
        if p.is_dir() {
            for e in walkdir::WalkDir::new(p).follow_links(true).into_iter().filter_entry(|e| e.depth() == 0 || !hidden(e.path())) {
                let Ok(e) = e else { continue };
                if !e.file_type().is_file() {
                    continue;
                }
                if let Some(fmt) = format_for_path(e.path()) {
                    out.push(Candidate { path: e.path().to_path_buf(), root: p.clone(), format: fmt });
                }
            }
        } else if let Some(fmt) = format_for_path(p) {
            let root = p.parent().map(Path::to_path_buf).unwrap_or_default();
            out.push(Candidate { path: p.clone(), root, format: fmt });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Text of a caught panic payload (`panic!` produces `&str` or `String`).
fn panic_msg(p: Box<dyn Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else {
        "unknown".to_string()
    }
}

pub type ProgressFn<'a> = &'a (dyn Fn(ImportProgress) + Sync);

/// Import synchronously (used by the background thread and by tests).
pub fn import_paths(state: &AppState, paths: &[PathBuf], progress: ProgressFn) -> AppResult<(ImportSummary, Vec<i64>)> {
    let _guard = state.import_lock.lock();
    let mut summary = ImportSummary::default();
    progress(ImportProgress { phase: "scanning".into(), done: 0, total: 0, message: "Scanning folders".into() });
    let cands = scan(paths);
    let total = cands.len();

    // Which files are new or changed?
    let mut todo: Vec<(usize, Option<i64>)> = vec![];
    {
        let conn = state.db.lock();
        for (i, c) in cands.iter().enumerate() {
            let p = c.path.to_string_lossy();
            match db::find_photo_by_path(&conn, &p)? {
                Some(ex) => {
                    let md = std::fs::metadata(&c.path).ok();
                    let mtime = md
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    let size = md.map(|m| m.len() as i64).unwrap_or(0);
                    if mtime == ex.mtime && size == ex.file_size {
                        db::set_missing(&conn, ex.id, false)?;
                        summary.unchanged += 1;
                    } else {
                        todo.push((i, Some(ex.id)));
                    }
                }
                None => todo.push((i, None)),
            }
        }
    }

    progress(ImportProgress { phase: "metadata".into(), done: 0, total: todo.len(), message: format!("Reading {} files", todo.len()) });
    let counter = std::sync::atomic::AtomicUsize::new(0);
    let metas: Vec<(usize, Option<i64>, Result<PhotoMeta, String>)> = todo
        .par_iter()
        .map(|(i, existing)| {
            let c = &cands[*i];
            // Third-party decoders (rawler, image) can panic on unusual files; one bad
            // file must not abort the whole import, so a panic becomes a per-file error.
            let r = match catch_unwind(AssertUnwindSafe(|| metadata::read_meta(&c.path, c.format))) {
                Ok(r) => r.map_err(|e| format!("{}: {e}", c.path.display())),
                Err(p) => Err(format!("{}: decoder panicked: {}", c.path.display(), panic_msg(p))),
            };
            let n = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if n % 25 == 0 {
                progress(ImportProgress { phase: "metadata".into(), done: n, total: todo.len(), message: String::new() });
            }
            (*i, *existing, r)
        })
        .collect();

    let mut thumb_jobs: Vec<(i64, PathBuf, &'static str)> = vec![];
    {
        let mut conn = state.db.lock();
        let batch = db::next_import_batch(&conn)?;
        let tx = conn.transaction()?;
        for (i, existing, r) in metas {
            let c = &cands[i];
            let m = match r {
                Ok(m) => m,
                Err(e) => {
                    summary.errors.push(e);
                    continue;
                }
            };
            let parent = c.path.parent().unwrap_or(&c.root).to_path_buf();
            match existing {
                Some(id) => {
                    db::update_photo_meta(&tx, id, &m)?;
                    state.sources.invalidate(id);
                    summary.updated += 1;
                    thumb_jobs.push((id, c.path.clone(), c.format));
                }
                None => {
                    let folder = db::ensure_folder(&tx, &parent, &c.root)?;
                    let (photo_id, image_id) = db::insert_photo(&tx, folder, &m, batch)?;
                    if let Some(sc) = xmp::read(&c.path) {
                        db::set_rating(&tx, &[image_id], sc.rating)?;
                        if !sc.label.is_empty() {
                            db::set_color_label(&tx, &[image_id], &sc.label)?;
                        }
                        db::add_keywords(&tx, &[photo_id], &sc.keywords)?;
                        if let Some(p) = sc.params {
                            db::save_params(&tx, image_id, &p, true, Some("Restored from sidecar"))?;
                        }
                    }
                    summary.added += 1;
                    thumb_jobs.push((photo_id, c.path.clone(), c.format));
                }
            }
        }
        tx.commit()?;
    }

    // Mark files that disappeared from the scanned folders.
    {
        let conn = state.db.lock();
        let folders = db::list_folders(&conn)?;
        let scanned: Vec<i64> = folders
            .iter()
            .filter(|f| paths.iter().any(|p| p.is_dir() && Path::new(&f.path).starts_with(p)))
            .map(|f| f.id)
            .collect();
        for (id, path) in db::photos_in_folders(&conn, &scanned)? {
            if !Path::new(&path).exists() {
                db::set_missing(&conn, id, true)?;
                summary.missing += 1;
            }
        }
    }

    progress(ImportProgress {
        phase: "thumbnails".into(),
        done: 0,
        total: thumb_jobs.len(),
        message: format!("Imported {} of {} files", summary.added + summary.updated, total),
    });
    let done = std::sync::atomic::AtomicUsize::new(0);
    let thumb_panics = parking_lot::Mutex::new(Vec::<String>::new());
    let ok_ids: Vec<i64> = thumb_jobs
        .par_iter()
        .filter_map(|(id, path, fmt)| {
            // Same as the metadata pass: a decoder panic only loses this thumbnail.
            let r = catch_unwind(AssertUnwindSafe(|| thumbs::generate(&state.cache_dir, *id, path, fmt)));
            let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if n % 8 == 0 || n == thumb_jobs.len() {
                progress(ImportProgress { phase: "thumbnails".into(), done: n, total: thumb_jobs.len(), message: String::new() });
            }
            match r {
                Ok(Ok(())) => Some(*id),
                Ok(Err(e)) => {
                    log::warn!("thumbnail {}: {e}", path.display());
                    None
                }
                Err(p) => {
                    let msg = panic_msg(p);
                    log::warn!("thumbnail {}: decoder panicked: {msg}", path.display());
                    thumb_panics.lock().push(format!("{} (thumbnail): decoder panicked: {msg}", path.display()));
                    None
                }
            }
        })
        .collect();
    summary.errors.extend(thumb_panics.into_inner());
    {
        let conn = state.db.lock();
        for id in &ok_ids {
            db::set_thumb_ok(&conn, *id, true)?;
        }
    }
    summary.thumbnails = ok_ids.len();
    Ok((summary, ok_ids))
}

pub fn spawn(app: AppHandle, paths: Vec<PathBuf>) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let emit = |p: ImportProgress| {
            let _ = app.emit("import:progress", p);
        };
        // Per-file panics are caught inside; this catches anything else so the UI
        // always gets `import:done` and never waits on a dead thread.
        let result = catch_unwind(AssertUnwindSafe(|| import_paths(&state, &paths, &emit)));
        let summary = match result {
            Ok(Ok((summary, _))) => summary,
            Ok(Err(e)) => ImportSummary { errors: vec![e.to_string()], ..Default::default() },
            Err(p) => ImportSummary { errors: vec![format!("import panicked: {}", panic_msg(p))], ..Default::default() },
        };
        let _ = app.emit("import:done", summary);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_msg_reads_str_and_string_payloads() {
        let p = catch_unwind(|| panic!("static")).unwrap_err();
        assert_eq!(panic_msg(p), "static");
        let p = catch_unwind(|| panic!("formatted {}", 7)).unwrap_err();
        assert_eq!(panic_msg(p), "formatted 7");
        let p = catch_unwind(|| std::panic::panic_any(42u32)).unwrap_err();
        assert_eq!(panic_msg(p), "unknown");
    }
}
