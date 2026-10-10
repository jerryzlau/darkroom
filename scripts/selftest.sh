#!/usr/bin/env bash
# Run the in-app end-to-end self-test against an isolated catalog.
# Usage: scripts/selftest.sh [path/to/Darkroom.app/Contents/MacOS/darkroom]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/apps/desktop/src-tauri/target/release/darkroom}"
WORK="$(mktemp -d -t darkroom-selftest)"
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
SAMPLES="$WORK/samples"
( cd "$ROOT/apps/desktop/src-tauri" && cargo run --release --quiet --example make_samples -- "$SAMPLES" 3000 2000 )
mkdir -p "$WORK/out"
echo "work dir: $WORK"
DARKROOM_SELFTEST=1 DARKROOM_DATA_DIR="$WORK/data" DARKROOM_SELFTEST_SAMPLES="$SAMPLES" DARKROOM_SELFTEST_OUT="$WORK/out" \
  perl -e 'alarm shift; exec @ARGV' 300 "$BIN" 2>&1 | tee "$WORK/run.log" | grep -E "SELFTEST|ERROR|error" || true
ls -la "$WORK/out"
grep -q "SELFTEST PASS" "$WORK/run.log" && echo "SELFTEST PASSED" || { echo "SELFTEST FAILED"; exit 1; }
