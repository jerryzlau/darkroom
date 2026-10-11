//! Content-addressed store for generative-fill patches.
//!
//! Each patch is an sRGB 8-bit PNG saved as `<data_dir>/patches/<sha256>.png`;
//! edit params reference it only by hash. Because the store is content
//! addressed, one file is shared by every virtual copy and history entry that
//! points at it, so files are never deleted here (a GC command that sweeps
//! hashes no longer referenced by any params/history/snapshot/preset is future
//! work). XMP sidecars carry the params JSON (and thus the hash) but not the
//! PNG bytes, so a sidecar moved to another machine needs the store too.

use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("patches")
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Store a PNG; returns its sha256 hex. Idempotent.
pub fn save(data_dir: &Path, bytes: &[u8]) -> AppResult<String> {
    if bytes.len() < PNG_SIGNATURE.len() || bytes[..8] != PNG_SIGNATURE {
        return Err(AppError::Other("not a PNG".into()));
    }
    let hash = hex::encode(Sha256::digest(bytes));
    let d = dir(data_dir);
    fs::create_dir_all(&d)?;
    let out = d.join(format!("{hash}.png"));
    if out.exists() {
        return Ok(hash);
    }
    let tmp = d.join(format!("{hash}.png.tmp-{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, &out) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(hash)
}

/// Read a stored PNG by hash.
pub fn read(data_dir: &Path, hash: &str) -> AppResult<Vec<u8>> {
    if !valid_hash(hash) {
        return Err(AppError::Other("bad patch hash".into()));
    }
    fs::read(dir(data_dir).join(format!("{hash}.png"))).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("patch {hash}"))
        } else {
            e.into()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(extra: &[u8]) -> Vec<u8> {
        let mut v = PNG_SIGNATURE.to_vec();
        v.extend_from_slice(extra);
        v
    }

    #[test]
    fn roundtrip() {
        let t = tempfile::tempdir().unwrap();
        let bytes = png(b"hello");
        let h = save(t.path(), &bytes).unwrap();
        assert_eq!(h.len(), 64);
        assert_eq!(read(t.path(), &h).unwrap(), bytes);
    }

    #[test]
    fn idempotent() {
        let t = tempfile::tempdir().unwrap();
        let bytes = png(b"same");
        let a = save(t.path(), &bytes).unwrap();
        let b = save(t.path(), &bytes).unwrap();
        assert_eq!(a, b);
        let n = fs::read_dir(dir(t.path())).unwrap().count();
        assert_eq!(n, 1);
    }

    #[test]
    fn rejects_non_png() {
        let t = tempfile::tempdir().unwrap();
        assert!(matches!(save(t.path(), b"\xff\xd8\xff\xe0jpeg"), Err(AppError::Other(_))));
        assert!(matches!(save(t.path(), b""), Err(AppError::Other(_))));
    }

    #[test]
    fn rejects_bad_hash() {
        let t = tempfile::tempdir().unwrap();
        assert!(matches!(read(t.path(), "../etc/passwd"), Err(AppError::Other(_))));
        assert!(matches!(read(t.path(), &"A".repeat(64)), Err(AppError::Other(_))));
        assert!(matches!(read(t.path(), &"a".repeat(63)), Err(AppError::Other(_))));
    }

    #[test]
    fn missing_is_not_found() {
        let t = tempfile::tempdir().unwrap();
        assert!(matches!(read(t.path(), &"0".repeat(64)), Err(AppError::NotFound(_))));
    }
}
