//! Pixel sources for the GPU renderer.
//!
//! * `preview`: the whole image at <= PREVIEW_SIZE long edge, cached on disk
//!   (zstd) so reopening a photo is instant.
//! * `region`: any rectangle of the full-resolution image at any scale, used
//!   for zoomed views, sharp fit views on large displays, and export tiles.
//!
//! Full decodes are kept in a small in-memory LRU.

use crate::decode::{self, fit_dims, SourceColor, SourceImage};
use crate::error::{AppError, AppResult};
use lru::LruCache;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const PREVIEW_SIZE: usize = 2560;
const PREVIEW_CACHE_VERSION: u32 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHeader {
    pub photo_id: i64,
    pub width: usize,
    pub height: usize,
    pub preview_width: usize,
    pub preview_height: usize,
    pub color: SourceColor,
}

pub struct SourceCache {
    full: Mutex<LruCache<i64, Arc<SourceImage>>>,
    locks: Mutex<HashMap<i64, Arc<Mutex<()>>>>,
}

impl Default for SourceCache {
    fn default() -> Self {
        Self { full: Mutex::new(LruCache::new(NonZeroUsize::new(3).unwrap())), locks: Mutex::new(HashMap::new()) }
    }
}

pub struct PhotoFile {
    pub id: i64,
    pub path: PathBuf,
    pub format: String,
    pub mtime: i64,
}

impl SourceCache {
    pub fn invalidate(&self, photo_id: i64) {
        self.full.lock().pop(&photo_id);
    }

    pub fn full(&self, f: &PhotoFile) -> AppResult<Arc<SourceImage>> {
        if let Some(img) = self.full.lock().get(&f.id) {
            return Ok(img.clone());
        }
        let lock = self.locks.lock().entry(f.id).or_insert_with(|| Arc::new(Mutex::new(()))).clone();
        let _guard = lock.lock();
        if let Some(img) = self.full.lock().get(&f.id) {
            return Ok(img.clone());
        }
        if !f.path.exists() {
            return Err(AppError::NotFound(format!("file is missing: {}", f.path.display())));
        }
        let t = std::time::Instant::now();
        let img = Arc::new(decode::decode_file(&f.path, &f.format)?);
        log::info!("decoded {} ({}x{}) in {:?}", f.path.display(), img.width, img.height, t.elapsed());
        self.full.lock().put(f.id, img.clone());
        Ok(img)
    }
}

fn preview_cache_path(cache: &Path, f: &PhotoFile) -> PathBuf {
    cache.join("previews").join(format!("{}-{}-v{}.zst", f.id, f.mtime, PREVIEW_CACHE_VERSION))
}

fn u16_bytes(v: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 2);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Wire format: u32 header length, JSON header, zero padding to 4 bytes, u16 LE RGB data.
fn pack(header: &PreviewHeader, data: &[u16]) -> AppResult<Vec<u8>> {
    let json = serde_json::to_vec(header)?;
    let pad = (4 - (4 + json.len()) % 4) % 4;
    let mut out = Vec::with_capacity(4 + json.len() + pad + data.len() * 2);
    out.extend_from_slice(&(json.len() as u32 + pad as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend(std::iter::repeat_n(b' ', pad));
    out.extend_from_slice(&u16_bytes(data));
    Ok(out)
}

/// Packed preview bytes, plus the full-resolution size when it was freshly decoded.
pub type PreviewResult = (Vec<u8>, Option<(usize, usize)>);

pub fn preview(cache_dir: &Path, sources: &SourceCache, f: &PhotoFile) -> AppResult<PreviewResult> {
    let cp = preview_cache_path(cache_dir, f);
    if let Ok(bytes) = std::fs::read(&cp) {
        if let Ok(raw) = zstd::decode_all(&bytes[..]) {
            return Ok((raw, None));
        }
    }
    let full = sources.full(f)?;
    let (pw, ph) = fit_dims(full.width, full.height, PREVIEW_SIZE);
    let data = if (pw, ph) == (full.width, full.height) {
        full.data.clone()
    } else {
        decode::resize_u16_rgb(&full.data, full.width, full.height, None, pw, ph)?
    };
    let header = PreviewHeader {
        photo_id: f.id,
        width: full.width,
        height: full.height,
        preview_width: pw,
        preview_height: ph,
        color: full.color.clone(),
    };
    let packed = pack(&header, &data)?;
    if let Some(dir) = cp.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Remove stale cache files for this photo (older mtimes / versions).
    if let Ok(rd) = std::fs::read_dir(cp.parent().unwrap()) {
        let prefix = format!("{}-", f.id);
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && e.path() != cp {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let compressed = zstd::encode_all(&packed[..], 1)?;
    let tmp = cp.with_extension("tmp");
    std::fs::write(&tmp, compressed)?;
    std::fs::rename(&tmp, &cp)?;
    Ok((packed, Some((full.width, full.height))))
}

/// Region of the full-resolution image (x, y, w, h in full-res pixels),
/// resampled to ow x oh. Wire format: u32 ow, u32 oh, u16 LE RGB data.
pub fn region(sources: &SourceCache, f: &PhotoFile, x: f64, y: f64, w: f64, h: f64, ow: usize, oh: usize) -> AppResult<Vec<u8>> {
    let full = sources.full(f)?;
    let fw = full.width as f64;
    let fh = full.height as f64;
    let x0 = x.clamp(0.0, fw - 1.0);
    let y0 = y.clamp(0.0, fh - 1.0);
    let w = w.min(fw - x0).max(1.0);
    let h = h.min(fh - y0).max(1.0);
    let ow = ow.clamp(1, 16384);
    let oh = oh.clamp(1, 16384);
    let exact = (w - ow as f64).abs() < 1e-6 && (h - oh as f64).abs() < 1e-6 && x0.fract() == 0.0 && y0.fract() == 0.0;
    let data: Vec<u16> = if exact {
        let (xi, yi) = (x0 as usize, y0 as usize);
        let mut out = Vec::with_capacity(ow * oh * 3);
        for row in yi..yi + oh {
            let s = (row * full.width + xi) * 3;
            out.extend_from_slice(&full.data[s..s + ow * 3]);
        }
        out
    } else {
        decode::resize_u16_rgb(&full.data, full.width, full.height, Some((x0, y0, w, h)), ow, oh)?
    };
    let mut out = Vec::with_capacity(8 + data.len() * 2);
    out.extend_from_slice(&(ow as u32).to_le_bytes());
    out.extend_from_slice(&(oh as u32).to_le_bytes());
    out.extend_from_slice(&u16_bytes(&data));
    Ok(out)
}

/// Keep the preview cache under `max_bytes` by deleting the oldest files.
pub fn trim_preview_cache(cache_dir: &Path, max_bytes: u64) {
    let dir = cache_dir.join("previews");
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            Some((md.accessed().or_else(|_| md.modified()).ok()?, md.len(), e.path()))
        })
        .collect();
    let total: u64 = files.iter().map(|f| f.1).sum();
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|f| f.0);
    let mut excess = total - max_bytes;
    for (_, len, path) in files {
        if excess == 0 {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            excess = excess.saturating_sub(len);
        }
    }
}
