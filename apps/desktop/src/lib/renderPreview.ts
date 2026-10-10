/**
 * Off-store renders of arbitrary params through the on-screen engine (option
 * thumbnails, AI context). Every render forces a full re-develop and leaves the
 * engine pointing at the rendered params until the next on-screen frame, so all
 * renders go through one serialized queue and each is followed by a redraw.
 */
import type { EditParams } from '@darkroom/core';
import { computeHistogram } from '../engine/Engine';
import { useDevelop } from '../state/develop';
import { getEngine, requestRedraw } from '../state/engineHub';
import { toJpeg } from './background';

/** Output size for a render of `params` with the long edge at `longEdge` (crop and rotation aware). */
export function thumbSize(params: EditParams, info: { width: number; height: number }, longEdge: number): { w: number; h: number } {
  const g = params.geometry;
  const fw = g.rotate % 2 ? info.height : info.width;
  const fh = g.rotate % 2 ? info.width : info.height;
  const ar = (g.crop.w * fw) / (g.crop.h * fh);
  const w = Math.max(1, ar >= 1 ? longEdge : Math.round(longEdge * ar));
  const h = Math.max(1, ar >= 1 ? Math.round(longEdge / ar) : longEdge);
  return { w, h };
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface RenderOpts {
  overlayMask?: number;
  overlayInvert?: boolean;
  /** false: not dropped by cancelPreviewRenders() (used for AI context renders). Default true. */
  cancellable?: boolean;
  /** Cancellation scope: cancelPreviewRenders(scope) only drops jobs queued under the same scope. Default 'default'. */
  scope?: string;
}

let queue: Promise<unknown> = Promise.resolve();
const generations = new Map<string, number>();

const nextMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));

/** Render `params` (sRGB RGBA8) via the on-screen engine; null when stale, cancelled or no photo is loaded. */
export function renderParamsPixels(params: EditParams, longEdge: number, opts: RenderOpts = {}): Promise<{ px: Uint8Array; w: number; h: number } | null> {
  const scope = opts.scope ?? 'default';
  const gen = generations.get(scope) ?? 0;
  const cancellable = opts.cancellable ?? true;
  const job = queue.then(() => {
    if (cancellable && gen !== (generations.get(scope) ?? 0)) return null;
    const e = getEngine();
    const s = useDevelop.getState();
    if (!e || !s.source) return null;
    const { w, h } = thumbSize(params, s.source.info, longEdge);
    // no await between sync and renderSmall: the engine must not be shared mid-render
    e.sync(s.source, params, s.base);
    let px: Uint8Array | null = null;
    try {
      px = e.renderSmall(w, h, 'srgb', { before: false }, { overlayMask: opts.overlayMask ?? -1, overlayInvert: opts.overlayInvert ?? false });
    } finally {
      requestRedraw();
    }
    return px ? { px, w, h } : null;
  });
  // let the on-screen frame repaint between jobs; a failed job must not stall the queue
  queue = job.then(nextMacrotask, nextMacrotask);
  return job;
}

/** Render `params` as a JPEG data URL. */
export async function renderParamsThumb(params: EditParams, longEdge = 192, quality = 0.8, opts: RenderOpts = {}): Promise<string | null> {
  const r = await renderParamsPixels(params, longEdge, opts);
  if (!r) return null;
  return `data:image/jpeg;base64,${toBase64(await toJpeg(r.px, r.w, r.h, quality))}`;
}

/** Drop queued (cancellable) renders of `scope`: they resolve null. Other scopes are untouched. */
export function cancelPreviewRenders(scope = 'default'): void {
  generations.set(scope, (generations.get(scope) ?? 0) + 1);
}

const pct = (n: number, total: number) => `${(Math.round((n / total) * 1000) / 10).toFixed(1)}%`;

/** One-line histogram summary of an RGBA8 buffer: clipping and median luminance. */
export function histogramSummary(px: Uint8Array, w: number, h: number): string {
  const { l } = computeHistogram(px);
  const total = Math.max(1, Math.min(w * h, px.length >> 2));
  const hi = l[254] + l[255];
  const lo = l[0] + l[1];
  let acc = 0;
  let median = 0;
  for (let i = 0; i < 256; i++) {
    acc += l[i];
    if (acc * 2 >= total) {
      median = i;
      break;
    }
  }
  return `Histogram: highlights clipped ${pct(hi, total)}, shadows clipped ${pct(lo, total)}, median luminance ${Math.round((median / 255) * 100)}%`;
}
