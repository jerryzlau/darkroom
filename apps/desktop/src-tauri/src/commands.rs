//! Tauri commands: the IPC surface used by the UI (see src/ipc/backend.ts).

use crate::db::{self, Collection, Folder, HistoryEntry, ImageQuery, ImageRow, Preset, Snapshot};
use crate::error::{AppError, AppResult};
use crate::export::{self, ExportJob, ExportSpec};
use crate::state::AppState;
use crate::{import, patches, source, thumbs, xmp};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};

type Cmd<T> = Result<T, AppError>;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_folders(state: State<'_, AppState>) -> Cmd<Vec<Folder>> {
    db::list_folders(&state.db.lock())
}

#[tauri::command]
pub fn list_collections(state: State<'_, AppState>) -> Cmd<Vec<Collection>> {
    db::list_collections(&state.db.lock())
}

#[tauri::command]
pub fn list_images(state: State<'_, AppState>, query: ImageQuery) -> Cmd<Vec<ImageRow>> {
    db::list_images(&state.db.lock(), &query)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDetail {
    pub image: ImageRow,
    pub params: Option<String>,
    pub keywords: Vec<String>,
}

#[tauri::command]
pub fn get_image(state: State<'_, AppState>, id: i64) -> Cmd<ImageDetail> {
    let conn = state.db.lock();
    let image = db::get_image(&conn, id)?;
    let params = db::get_params(&conn, id)?;
    let keywords = db::photo_keywords(&conn, image.photo_id)?;
    Ok(ImageDetail { image, params, keywords })
}

#[tauri::command]
pub fn save_params(
    state: State<'_, AppState>,
    image_id: i64,
    params: String,
    edited: bool,
    label: Option<String>,
    truncate_after: Option<i64>,
) -> Cmd<Option<HistoryEntry>> {
    let conn = state.db.lock();
    if let Some(keep) = truncate_after {
        db::truncate_history_after(&conn, image_id, keep)?;
    }
    let entry = db::save_params(&conn, image_id, &params, edited, label.as_deref())?;
    let auto = db::get_setting(&conn, "autoWriteXmp")?.as_deref() == Some("true");
    if auto {
        drop(conn);
        let _ = write_sidecar(&state, image_id);
    }
    Ok(entry)
}

#[tauri::command]
pub fn list_history(state: State<'_, AppState>, image_id: i64) -> Cmd<Vec<HistoryEntry>> {
    db::list_history(&state.db.lock(), image_id)
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>, image_id: i64) -> Cmd<()> {
    db::clear_history(&state.db.lock(), image_id)
}

#[tauri::command]
pub fn list_snapshots(state: State<'_, AppState>, image_id: i64) -> Cmd<Vec<Snapshot>> {
    db::list_snapshots(&state.db.lock(), image_id)
}

#[tauri::command]
pub fn create_snapshot(state: State<'_, AppState>, image_id: i64, name: String, params: String) -> Cmd<i64> {
    db::create_snapshot(&state.db.lock(), image_id, &name, &params)
}

#[tauri::command]
pub fn delete_snapshot(state: State<'_, AppState>, id: i64) -> Cmd<()> {
    db::delete_snapshot(&state.db.lock(), id)
}

#[tauri::command]
pub fn list_presets(state: State<'_, AppState>) -> Cmd<Vec<Preset>> {
    db::list_presets(&state.db.lock())
}

#[tauri::command]
pub fn save_preset(
    state: State<'_, AppState>,
    group: String,
    name: String,
    params: String,
    description: Option<String>,
    source: Option<String>,
) -> Cmd<i64> {
    let description = description.unwrap_or_default();
    let source = source.unwrap_or_else(|| "user".into());
    db::save_preset(&state.db.lock(), &group, &name, &params, &description, &source)
}

#[tauri::command]
pub fn update_preset(state: State<'_, AppState>, id: i64, patch: db::PresetPatch) -> Cmd<()> {
    db::update_preset(&state.db.lock(), id, &patch)
}

#[tauri::command]
pub fn delete_preset(state: State<'_, AppState>, id: i64) -> Cmd<()> {
    db::delete_preset(&state.db.lock(), id)
}

#[tauri::command]
pub fn create_collection(state: State<'_, AppState>, name: String, kind: String, rules: Option<String>) -> Cmd<i64> {
    db::create_collection(&state.db.lock(), &name, &kind, rules.as_deref())
}

#[tauri::command]
pub fn update_collection(state: State<'_, AppState>, id: i64, name: String, rules: Option<String>) -> Cmd<()> {
    db::update_collection(&state.db.lock(), id, &name, rules.as_deref())
}

#[tauri::command]
pub fn delete_collection(state: State<'_, AppState>, id: i64) -> Cmd<()> {
    db::delete_collection(&state.db.lock(), id)
}

#[tauri::command]
pub fn add_to_collection(state: State<'_, AppState>, id: i64, image_ids: Vec<i64>) -> Cmd<()> {
    db::add_to_collection(&state.db.lock(), id, &image_ids)
}

#[tauri::command]
pub fn remove_from_collection(state: State<'_, AppState>, id: i64, image_ids: Vec<i64>) -> Cmd<()> {
    if image_ids.is_empty() {
        return Ok(());
    }
    db::remove_from_collection(&state.db.lock(), id, &image_ids)
}

#[tauri::command]
pub fn set_rating(state: State<'_, AppState>, ids: Vec<i64>, rating: i64) -> Cmd<()> {
    if ids.is_empty() {
        return Ok(());
    }
    db::set_rating(&state.db.lock(), &ids, rating)
}

#[tauri::command]
pub fn set_flag(state: State<'_, AppState>, ids: Vec<i64>, flag: i64) -> Cmd<()> {
    if ids.is_empty() {
        return Ok(());
    }
    db::set_flag(&state.db.lock(), &ids, flag)
}

#[tauri::command]
pub fn set_color_label(state: State<'_, AppState>, ids: Vec<i64>, label: String) -> Cmd<()> {
    if ids.is_empty() {
        return Ok(());
    }
    db::set_color_label(&state.db.lock(), &ids, &label)
}

#[tauri::command]
pub fn get_keywords(state: State<'_, AppState>, photo_id: i64) -> Cmd<Vec<String>> {
    db::photo_keywords(&state.db.lock(), photo_id)
}

#[tauri::command]
pub fn all_keywords(state: State<'_, AppState>) -> Cmd<Vec<(String, i64)>> {
    db::all_keywords(&state.db.lock())
}

#[tauri::command]
pub fn add_keywords(state: State<'_, AppState>, photo_ids: Vec<i64>, names: Vec<String>) -> Cmd<()> {
    db::add_keywords(&state.db.lock(), &photo_ids, &names)
}

#[tauri::command]
pub fn remove_keyword(state: State<'_, AppState>, photo_ids: Vec<i64>, name: String) -> Cmd<()> {
    if photo_ids.is_empty() {
        return Ok(());
    }
    db::remove_keyword(&state.db.lock(), &photo_ids, &name)
}

#[tauri::command]
pub fn create_virtual_copy(state: State<'_, AppState>, image_id: i64) -> Cmd<i64> {
    let conn = state.db.lock();
    let id = db::create_virtual_copy(&conn, image_id)?;
    // carry over the edited thumbnail
    let src = thumbs::edit_thumb_path(&state.cache_dir, image_id);
    if src.exists() {
        let dst = thumbs::edit_thumb_path(&state.cache_dir, id);
        if std::fs::copy(&src, &dst).is_ok() {
            db::bump_thumb_rev(&conn, id)?;
        }
    }
    Ok(id)
}

#[tauri::command]
pub fn remove_images(state: State<'_, AppState>, image_ids: Vec<i64>) -> Cmd<()> {
    let photos = db::remove_images(&state.db.lock(), &image_ids)?;
    for p in photos {
        state.sources.invalidate(p);
        let _ = std::fs::remove_file(thumbs::thumb_path(&state.cache_dir, p));
    }
    for i in image_ids {
        let _ = std::fs::remove_file(thumbs::edit_thumb_path(&state.cache_dir, i));
    }
    Ok(())
}

#[tauri::command]
pub fn remove_folder(state: State<'_, AppState>, id: i64) -> Cmd<()> {
    let photos = db::remove_folder(&state.db.lock(), id)?;
    for p in photos {
        state.sources.invalidate(p);
    }
    Ok(())
}

#[tauri::command]
pub fn import_paths(app: AppHandle, paths: Vec<String>) -> Cmd<()> {
    import::spawn(app, paths.into_iter().map(PathBuf::from).collect());
    Ok(())
}

#[tauri::command]
pub fn rescan_folder(app: AppHandle, state: State<'_, AppState>, id: i64) -> Cmd<()> {
    let path: String = state.db.lock().query_row("SELECT path FROM folders WHERE id = ?1", [id], |r| r.get(0))?;
    import::spawn(app, vec![PathBuf::from(path)]);
    Ok(())
}

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Cmd<Option<String>> {
    db::get_setting(&state.db.lock(), &key)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Cmd<()> {
    db::set_setting(&state.db.lock(), &key, &value)
}

fn write_sidecar(state: &AppState, image_id: i64) -> AppResult<PathBuf> {
    let conn = state.db.lock();
    let img = db::get_image(&conn, image_id)?;
    let params = if img.edited { db::get_params(&conn, image_id)? } else { None };
    let keywords = db::photo_keywords(&conn, img.photo_id)?;
    drop(conn);
    xmp::write(
        std::path::Path::new(&img.meta.path),
        &xmp::SidecarData { rating: img.rating, label: img.color_label, keywords, params },
    )
}

#[tauri::command]
pub fn write_sidecars(state: State<'_, AppState>, image_ids: Vec<i64>) -> Cmd<usize> {
    let mut n = 0;
    for id in image_ids {
        // Only master images write sidecars (copies would overwrite the master's).
        let is_master = db::get_image(&state.db.lock(), id)?.copy_name.is_none();
        if is_master && write_sidecar(&state, id).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Cmd<()> {
    std::process::Command::new("/usr/bin/open").arg("-R").arg(path).spawn()?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub data_dir: String,
    pub cache_dir: String,
    pub version: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        data_dir: state.data_dir.to_string_lossy().to_string(),
        cache_dir: state.cache_dir.to_string_lossy().to_string(),
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[ui] {message}"),
        "warn" => log::warn!("[ui] {message}"),
        _ => log::info!("[ui] {message}"),
    }
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_preview(app: AppHandle, photo_id: i64) -> Cmd<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let f = state.photo_file(photo_id)?;
        let (bytes, dims) = source::preview(&state.cache_dir, &state.sources, &f)?;
        if let Some((w, h)) = dims {
            db::set_photo_dims(&state.db.lock(), photo_id, w as i64, h as i64)?;
        }
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn get_region(app: AppHandle, photo_id: i64, x: f64, y: f64, w: f64, h: f64, ow: usize, oh: usize) -> Cmd<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let f = state.photo_file(photo_id)?;
        Ok(Response::new(source::region(&state.sources, &f, x, y, w, h, ow, oh)?))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

fn header<'a>(req: &'a Request<'_>, name: &str) -> AppResult<&'a str> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Other(format!("missing header {name}")))
}

fn raw_body(req: &Request<'_>) -> AppResult<Vec<u8>> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err(AppError::Other("expected a binary body".into())),
    }
}

/// Store a UI-rendered JPEG thumbnail for an edited image. Returns the new thumb revision.
#[tauri::command]
pub fn save_edit_thumb(state: State<'_, AppState>, request: Request<'_>) -> Cmd<i64> {
    let image_id: i64 = header(&request, "x-image-id")?.parse().map_err(|_| AppError::Other("bad id".into()))?;
    let body = raw_body(&request)?;
    let out = thumbs::edit_thumb_path(&state.cache_dir, image_id);
    if let Some(d) = out.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(&out, body)?;
    db::bump_thumb_rev(&state.db.lock(), image_id)
}

/// Store a generative-fill PNG (raw body) in the content-addressed patch store. Returns its sha256 hex.
#[tauri::command]
pub fn save_patch(state: State<'_, AppState>, request: Request<'_>) -> Cmd<String> {
    let body = raw_body(&request)?;
    patches::save(&state.data_dir, &body)
}

/// Read a stored generative-fill PNG by hash.
#[tauri::command]
pub async fn get_patch(app: AppHandle, hash: String) -> Cmd<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        Ok(Response::new(patches::read(&state.data_dir, &hash)?))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn reset_edit_thumb(state: State<'_, AppState>, image_id: i64) -> Cmd<()> {
    let _ = std::fs::remove_file(thumbs::edit_thumb_path(&state.cache_dir, image_id));
    db::reset_thumb_rev(&state.db.lock(), image_id)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn export_begin(state: State<'_, AppState>, spec: ExportSpec) -> Cmd<u64> {
    let job = ExportJob::new(spec)?;
    let id = state.next_job.fetch_add(1, Ordering::Relaxed);
    state.exports.lock().insert(id, job);
    Ok(id)
}

#[tauri::command]
pub fn export_tile(state: State<'_, AppState>, request: Request<'_>) -> Cmd<()> {
    let p = |n: &str| -> AppResult<u32> { header(&request, n)?.parse().map_err(|_| AppError::Other(format!("bad {n}"))) };
    let job_id: u64 = header(&request, "x-job")?.parse().map_err(|_| AppError::Other("bad job".into()))?;
    let (x, y, w, h) = (p("x-x")?, p("x-y")?, p("x-w")?, p("x-h")?);
    let body = raw_body(&request)?;
    let mut jobs = state.exports.lock();
    let job = jobs.get_mut(&job_id).ok_or_else(|| AppError::NotFound("export job".into()))?;
    job.put_tile(x, y, w, h, &body)
}

#[tauri::command]
pub async fn export_finish(app: AppHandle, job_id: u64) -> Cmd<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let job = state.exports.lock().remove(&job_id).ok_or_else(|| AppError::NotFound("export job".into()))?;
        let meta = db::get_image(&state.db.lock(), job.spec.image_id).map(|i| i.meta).unwrap_or_default();
        let path = export::finish(job, &meta)?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn export_cancel(state: State<'_, AppState>, job_id: u64) -> Cmd<()> {
    state.exports.lock().remove(&job_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Self-test support (only active when DARKROOM_SELFTEST=1)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelftestConfig {
    pub enabled: bool,
    pub samples_dir: String,
    pub out_dir: String,
}

#[tauri::command]
pub fn selftest_config() -> SelftestConfig {
    SelftestConfig {
        enabled: std::env::var("DARKROOM_SELFTEST").map(|v| v == "1").unwrap_or(false),
        samples_dir: std::env::var("DARKROOM_SELFTEST_SAMPLES").unwrap_or_default(),
        out_dir: std::env::var("DARKROOM_SELFTEST_OUT").unwrap_or_default(),
    }
}

#[tauri::command]
pub fn exit_app(app: AppHandle, code: i32) {
    if std::env::var("DARKROOM_SELFTEST").map(|v| v == "1").unwrap_or(false) {
        app.exit(code);
    }
}
