use crate::export::ExportJob;
use crate::source::{PhotoFile, SourceCache};
use crate::{db, error::AppResult};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub cache_dir: PathBuf,
    pub data_dir: PathBuf,
    pub sources: SourceCache,
    pub exports: Mutex<HashMap<u64, ExportJob>>,
    pub next_job: AtomicU64,
    pub import_lock: Mutex<()>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, cache_dir: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(&cache_dir)?;
        let conn = db::open(&data_dir.join("catalog.sqlite"))?;
        if let Err(e) = db::daily_backup(&conn, &data_dir.join("backups"), 7) {
            log::warn!("catalog backup failed: {e}");
        }
        Ok(Self {
            db: Mutex::new(conn),
            cache_dir,
            data_dir,
            sources: SourceCache::default(),
            exports: Mutex::new(HashMap::new()),
            next_job: AtomicU64::new(1),
            import_lock: Mutex::new(()),
        })
    }

    pub fn photo_file(&self, photo_id: i64) -> AppResult<PhotoFile> {
        let (path, format, mtime) = db::photo_path(&self.db.lock(), photo_id)?;
        Ok(PhotoFile { id: photo_id, path: PathBuf::from(path), format, mtime })
    }
}
