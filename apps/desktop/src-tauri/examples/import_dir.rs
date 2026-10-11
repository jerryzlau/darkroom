//! Run the real import pipeline (metadata + thumbnails) on a folder against a
//! throwaway catalog and print the summary. Useful to check a photo collection
//! imports cleanly without launching the app.
//!
//!   cargo run --release --example import_dir -- <dir> [--limit N]

use darkroom_lib::import::{import_paths, ImportProgress};
use darkroom_lib::state::AppState;
use std::path::PathBuf;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut limit = usize::MAX;
    if let Some(i) = args.iter().position(|a| a == "--limit") {
        limit = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(limit);
        args.drain(i..i + 2);
    }
    let dir = PathBuf::from(args.first().expect("usage: import_dir <dir> [--limit N]"));
    let mut paths: Vec<PathBuf> = if dir.is_dir() && limit != usize::MAX {
        let mut v: Vec<PathBuf> = std::fs::read_dir(&dir).expect("read dir").flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
        v.sort();
        v.truncate(limit);
        v
    } else {
        vec![dir]
    };
    paths.sort();

    let work = std::env::temp_dir().join(format!("darkroom-import-{}", std::process::id()));
    let state = AppState::new(work.join("data"), work.join("cache")).expect("state");
    let t0 = std::time::Instant::now();
    let progress = |p: ImportProgress| {
        if p.done == 0 || p.done % 100 == 0 {
            eprintln!("  {} {}/{} {}", p.phase, p.done, p.total, p.message);
        }
    };
    match import_paths(&state, &paths, &progress) {
        Ok((s, ids)) => {
            println!(
                "added {} updated {} unchanged {} missing {} thumbnails {} errors {} in {:.1}s",
                s.added,
                s.updated,
                s.unchanged,
                s.missing,
                s.thumbnails,
                s.errors.len(),
                t0.elapsed().as_secs_f32()
            );
            for e in s.errors.iter().take(5) {
                println!("  error: {e}");
            }
            println!("thumbnail ok for {} photos; work dir {}", ids.len(), work.display());
        }
        Err(e) => println!("import failed: {e}"),
    }
    let _ = std::fs::remove_dir_all(&work);
}
