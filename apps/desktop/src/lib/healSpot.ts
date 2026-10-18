/** Content-aware clone source for a spot: renders the neighbourhood through the on-screen engine and runs findHealSource. */
import type { EditParams } from '@darkroom/core';
import { useDevelop } from '../state/develop';
import { findHealSource, type Disc } from './healSource';
import { renderNeutralPixels } from './renderPreview';

/** neighbourhood half-size, in spot radii */
const REACH = 7;
const MAX_EDGE = 192;

/**
 * Best source UV for a spot at (x, y) with radius r (fraction of the long edge), or null when the
 * render or the search fails, or the photo changed meanwhile. `selfId` is dropped from the render and
 * from the exclusions (re-picking an existing spot).
 */
export async function searchSpotSource(params: EditParams, spot: { x: number; y: number; r: number; feather: number }, selfId?: string): Promise<[number, number] | null> {
  const d0 = useDevelop.getState();
  const source = d0.source;
  if (!source) return null;
  const imageId = d0.imageId;
  const { width: W, height: H } = source.info;
  const long = Math.max(W, H);
  const rx = (spot.r * long) / W;
  const ry = (spot.r * long) / H;
  const x0 = Math.max(0, spot.x - rx * REACH);
  const y0 = Math.max(0, spot.y - ry * REACH);
  const x1 = Math.min(1, spot.x + rx * REACH);
  const y1 = Math.min(1, spot.y + ry * REACH);
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return null;
  const pw = rw * W;
  const ph = rh * H;
  const edge = Math.max(16, Math.min(MAX_EDGE, Math.round(Math.max(pw, ph))));
  const w = Math.max(1, Math.round(pw >= ph ? edge : (edge * pw) / ph));
  const h = Math.max(1, Math.round(pw >= ph ? (edge * ph) / pw : edge));

  const renderParams: EditParams = selfId ? { ...params, spots: params.spots.filter((s) => s.id !== selfId) } : params;
  const ev = source.color.isRaw ? 0.5 : 0;
  const res = await renderNeutralPixels(renderParams, [x0, y0, rw, rh], w, h, { ev, scope: 'heal', cancellable: false });
  const d1 = useDevelop.getState();
  if (!res || d1.imageId !== imageId || d1.source !== source) return null;

  const toBuf = (u: number, v: number): [number, number] => [((u - x0) / rw) * w, ((v - y0) / rh) * h];
  const scale = (w / pw + h / ph) / 2; // buffer px per image px
  const rad = (r: number) => r * long * scale;
  const [dx, dy] = toBuf(spot.x, spot.y);
  const dest: Disc = { x: dx, y: dy, r: rad(spot.r) };
  const exclude: Disc[] = [];
  for (const s of params.spots) {
    if (s.id === selfId) continue;
    const [ex, ey] = toBuf(s.x, s.y);
    const er = rad(s.r);
    if (ex + er < 0 || ey + er < 0 || ex - er > w || ey - er > h) continue;
    exclude.push({ x: ex, y: ey, r: er });
  }
  const best = findHealSource(res.px, w, h, dest, { exclude, feather: spot.feather });
  if (!best) return null;
  return [x0 + (best.x / w) * rw, y0 + (best.y / h) * rh];
}
