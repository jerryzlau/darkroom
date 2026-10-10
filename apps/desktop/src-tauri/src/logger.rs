//! Minimal logger: stderr plus <data_dir>/darkroom.log (truncated at 5 MB).

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

struct Logger {
    file: Mutex<Option<std::fs::File>>,
}

impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info && (m.target().starts_with("darkroom") || m.level() <= log::Level::Warn)
    }
    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let line = format!("{} {:5} {}\n", chrono::Local::now().format("%H:%M:%S%.3f"), r.level(), r.args());
        eprint!("{line}");
        if let Ok(mut f) = self.file.lock() {
            if let Some(f) = f.as_mut() {
                let _ = f.write_all(line.as_bytes());
            }
        }
    }
    fn flush(&self) {}
}

pub fn init(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("darkroom.log");
    if std::fs::metadata(&path).map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(path).ok();
    let logger = Box::leak(Box::new(Logger { file: Mutex::new(file) }));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}
