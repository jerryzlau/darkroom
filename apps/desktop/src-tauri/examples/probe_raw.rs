//! Diagnose raw files that break the decoder: runs the same rawler calls the
//! importer uses on each path (or every raw file in a directory) under a panic
//! catcher and prints what each step returned.
//!
//!   cargo run --release --example probe_raw -- <file-or-dir>... [--limit N] [--quick]
//!
//! --quick stops after the embedded preview (what import needs); otherwise the
//! raw is fully decoded and developed too.

use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

fn step<T>(name: &str, f: impl FnOnce() -> anyhow::Result<T>) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => {
            println!("    {name}: ok");
            Some(v)
        }
        Ok(Err(e)) => {
            println!("    {name}: error: {e}");
            None
        }
        Err(p) => {
            let msg = p
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "non-string panic".into());
            println!("    {name}: PANIC: {msg}");
            None
        }
    }
}

fn probe(path: &Path, quick: bool) {
    println!("{}", path.display());
    let Some(src) = step("open", || Ok(RawSource::new(path)?)) else { return };
    let Some(decoder) = step("get_decoder", || Ok(rawler::get_decoder(&src)?)) else { return };
    let params = RawDecodeParams::default();
    if let Some(md) = step("raw_metadata", || Ok(decoder.raw_metadata(&src, &params)?)) {
        println!("      model {} {}", md.make, md.model);
    }
    if let Some(r) = step("raw_image(dummy)", || Ok(decoder.raw_image(&src, &params, true)?)) {
        println!("      dims {}x{} cpp {}", r.width, r.height, r.cpp);
    }
    step("preview_image", || Ok(decoder.preview_image(&src, &params)?));
    if quick {
        return;
    }
    if let Some(r) = step("raw_image(full)", || Ok(decoder.raw_image(&src, &params, false)?)) {
        println!("      dims {}x{} cpp {}", r.width, r.height, r.cpp);
        step("develop", || {
            rawler::imgop::develop::RawDevelop::default().develop_intermediate(&r)?;
            Ok(())
        });
    }
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut limit = usize::MAX;
    let quick = args.iter().any(|a| a == "--quick");
    args.retain(|a| a != "--quick");
    if let Some(i) = args.iter().position(|a| a == "--limit") {
        limit = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(limit);
        args.drain(i..i + 2);
    }
    let mut files: Vec<PathBuf> = vec![];
    for a in &args {
        let p = PathBuf::from(a);
        if p.is_dir() {
            let mut v: Vec<PathBuf> = std::fs::read_dir(&p)
                .expect("read dir")
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && !p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(true))
                .collect();
            v.sort();
            files.extend(v);
        } else {
            files.push(p);
        }
    }
    for f in files.iter().take(limit) {
        probe(f, quick);
    }
}
