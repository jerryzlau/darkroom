/**
 * Decoded generative-fill PNGs (by sha256), shared by every engine: the
 * on-screen one and the background one (export, batch thumbnails). Bitmaps are
 * fetched from the patch store on demand, deduped, and kept in a small LRU;
 * each engine uploads its own texture from them.
 */
import type { EditParams } from '@darkroom/core';
import type { Engine } from '../engine/Engine';
import { backend } from '../ipc/backend';

export type PatchAssetState = 'ready' | 'loading' | 'missing';

const MAX_BITMAPS = 32;

/** Insertion order = recency (touched entries are re-inserted). */
const bitmaps = new Map<string, ImageBitmap>();
const loading = new Map<string, Promise<ImageBitmap | null>>();
const missing = new Set<string>();
/** Assets the on-screen params need (from the latest prime): never evicted. */
let primed = new Set<string>();
/** Assets an in-flight ensurePatchAssets still has to upload. */
const pins = new Map<string, number>();

function assetsOf(p: EditParams): string[] {
  return [...new Set(p.patches.filter((x) => x.enabled).map((x) => x.asset))];
}

function touch(hash: string, bm: ImageBitmap) {
  bitmaps.delete(hash);
  bitmaps.set(hash, bm);
}

function evict() {
  if (bitmaps.size <= MAX_BITMAPS) return;
  for (const [h, bm] of bitmaps) {
    if (bitmaps.size <= MAX_BITMAPS) break;
    if (primed.has(h) || pins.has(h)) continue;
    bm.close();
    bitmaps.delete(h);
  }
}

function put(hash: string, bm: ImageBitmap) {
  const old = bitmaps.get(hash);
  if (old && old !== bm) old.close();
  missing.delete(hash);
  touch(hash, bm);
  evict();
}

export function patchAssetState(hash: string): PatchAssetState {
  if (bitmaps.has(hash)) return 'ready';
  if (missing.has(hash)) return 'missing';
  return 'loading';
}

/** Put a freshly generated PNG's bitmap in the cache (after backend.savePatch). */
export function registerPatchAsset(hash: string, bitmap: ImageBitmap): void {
  put(hash, bitmap);
}

/** Fetch + decode a PNG from the store (cached, deduped). Resolves null and marks it missing on failure. */
export function loadPatchAsset(hash: string): Promise<ImageBitmap | null> {
  const have = bitmaps.get(hash);
  if (have) {
    touch(hash, have);
    return Promise.resolve(have);
  }
  if (missing.has(hash)) return Promise.resolve(null);
  const inflight = loading.get(hash);
  if (inflight) return inflight;
  const job = (async () => {
    try {
      const bytes = await backend().getPatch(hash);
      const bm = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      put(hash, bm);
      return bm;
    } catch (e) {
      missing.add(hash);
      try {
        backend().log('warn', `patch ${hash}: ${e}`);
      } catch {
        // no backend (tests)
      }
      return null;
    } finally {
      loading.delete(hash);
    }
  })();
  loading.set(hash, job);
  return job;
}

function upload(e: Engine, hash: string, bm: ImageBitmap): boolean {
  try {
    e.setPatchAsset(hash, bm);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/**
 * Upload every cached asset that `p` needs into `e`; start loading the rest
 * and call `onReady` when one arrives. Returns true when all were present.
 * Synchronous.
 */
export function primePatchAssets(p: EditParams, e: Engine, onReady?: () => void): boolean {
  const hashes = assetsOf(p);
  primed = new Set(hashes);
  let all = true;
  for (const h of hashes) {
    if (e.hasPatchAsset(h)) continue;
    const bm = bitmaps.get(h);
    if (bm) {
      touch(h, bm);
      if (!upload(e, h, bm)) all = false;
      continue;
    }
    all = false;
    if (missing.has(h)) continue;
    void loadPatchAsset(h).then((b) => {
      if (b && onReady) onReady();
    });
  }
  return all;
}

/** Await all assets `p` needs and upload them into `e` (export / batch thumbnails). Missing ones are skipped. */
export async function ensurePatchAssets(p: EditParams, e: Engine): Promise<void> {
  const hashes = assetsOf(p);
  for (const h of hashes) pins.set(h, (pins.get(h) ?? 0) + 1);
  try {
    const loaded = await Promise.all(hashes.map((h) => (e.hasPatchAsset(h) ? Promise.resolve(null) : loadPatchAsset(h))));
    hashes.forEach((h, i) => {
      const bm = loaded[i];
      if (bm) upload(e, h, bm);
    });
  } finally {
    for (const h of hashes) {
      const n = (pins.get(h) ?? 1) - 1;
      if (n > 0) pins.set(h, n);
      else pins.delete(h);
    }
    evict();
  }
}

/** Forget a 'missing' verdict so it can be retried (e.g. after a regenerate). */
export function retryPatchAsset(hash: string): void {
  missing.delete(hash);
}
