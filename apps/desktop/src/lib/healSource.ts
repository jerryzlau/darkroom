/**
 * Content-aware source search for the Spot Removal tool (Lightroom-style heal):
 * pick the clone source whose surrounding ring continues the ring around the mark
 * and whose interior looks like the clean skin around the mark. DOM- and engine-free.
 */

/** A disc in buffer pixel coordinates (x right, y down). */
export interface Disc {
  x: number;
  y: number;
  r: number;
}

export interface HealSourceResult {
  x: number;
  y: number;
  /** lower is better */
  score: number;
}

/** sRGB 8-bit -> linear. */
const LUT = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

const ANGLES = 24;
/** candidate ring distances in units of r */
const RINGS = [2.2, 3, 4, 5.5, 7];
/** buffer margin around a candidate disc, in units of r */
const MARGIN = 0.3;
const CHROMA_W = 0.35;
const W_SEAM = 1;
const W_INTERIOR = 1;
const W_VARIANCE = 1.5;
/** score multiplier per r of extra distance, so near-ties go to the closer (better lit, same texture) candidate */
const DIST_PENALTY = 0.04;
/** additive floor so a perfectly flat buffer still prefers the closest candidate */
const SCORE_FLOOR = 1e-3;

interface Pattern {
  /** annulus offsets in units of r: [dx, dy] pairs, angle-major so index i matches across discs */
  ann: Float32Array;
  /** interior disc offsets in units of r */
  int: Float32Array;
}

function makePattern(feather: number): Pattern {
  const f = Math.min(1, Math.max(0, feather));
  // the heal blend reaches a little further out with more feather; sample the ring just beyond it
  const annR = [1.15, 1.35 + 0.1 * f, 1.55 + 0.15 * f];
  const ann: number[] = [];
  for (let a = 0; a < ANGLES; a++) {
    const t = (a / ANGLES) * Math.PI * 2;
    for (const k of annR) ann.push(Math.cos(t) * k, Math.sin(t) * k);
  }
  const int: number[] = [0, 0];
  for (const [k, n] of [
    [0.3, 8],
    [0.55, 12],
    [0.8, 16],
    [0.95, 20],
  ] as const) {
    for (let a = 0; a < n; a++) {
      const t = ((a + (n % 3) * 0.25) / n) * Math.PI * 2;
      int.push(Math.cos(t) * k, Math.sin(t) * k);
    }
  }
  return { ann: new Float32Array(ann), int: new Float32Array(int) };
}

/**
 * Find the best clone source for `dest` in an RGBA8 buffer (rows top-down).
 * Returns the source centre in buffer pixels, or null when no candidate disc fits.
 */
export function findHealSource(px: Uint8Array, w: number, h: number, dest: Disc, opts: { exclude?: Disc[]; feather?: number } = {}): HealSourceResult | null {
  const r = dest.r;
  if (!(r > 0) || w < 1 || h < 1 || px.length < w * h * 4) return null;
  const exclude = opts.exclude ?? [];
  const pat = makePattern(opts.feather ?? 0.35);

  // sample -> [Y, Cb, Cr] in linear light (nearest pixel, clamped to the buffer)
  const feat = (x: number, y: number, out: Float32Array, o: number) => {
    const ix = Math.min(w - 1, Math.max(0, Math.floor(x)));
    const iy = Math.min(h - 1, Math.max(0, Math.floor(y)));
    const i = (iy * w + ix) * 4;
    const R = LUT[px[i]];
    const G = LUT[px[i + 1]];
    const B = LUT[px[i + 2]];
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    out[o] = Y;
    out[o + 1] = B - Y;
    out[o + 2] = R - Y;
  };
  const dist2 = (a: Float32Array, i: number, b: Float32Array, j: number) => {
    const dy = a[i] - b[j];
    const db = a[i + 1] - b[j + 1];
    const dr = a[i + 2] - b[j + 2];
    return dy * dy + CHROMA_W * (db * db + dr * dr);
  };
  const inExcluded = (x: number, y: number, pad: number) => {
    if (Math.hypot(x - dest.x, y - dest.y) < dest.r * pad) return true;
    for (const e of exclude) if (Math.hypot(x - e.x, y - e.y) < e.r * pad) return true;
    return false;
  };

  // destination reference: the healthy ring around the mark
  const nA = pat.ann.length / 2;
  const nI = pat.int.length / 2;
  const destAnn = new Float32Array(nA * 3);
  const mean = new Float32Array(3);
  let nMean = 0;
  const destOk = new Uint8Array(nA);
  for (let i = 0; i < nA; i++) {
    const x = dest.x + pat.ann[i * 2] * r;
    const y = dest.y + pat.ann[i * 2 + 1] * r;
    feat(x, y, destAnn, i * 3);
    // another blemish touching the ring is not a reference for clean skin
    let bad = x < 0 || y < 0 || x >= w || y >= h;
    for (const e of exclude) if (Math.hypot(x - e.x, y - e.y) < e.r) bad = true;
    if (bad) continue;
    destOk[i] = 1;
    mean[0] += destAnn[i * 3];
    mean[1] += destAnn[i * 3 + 1];
    mean[2] += destAnn[i * 3 + 2];
    nMean++;
  }
  if (nMean === 0) {
    // degenerate (ring fully covered): fall back to every ring sample
    for (let i = 0; i < nA; i++) {
      destOk[i] = 1;
      for (let c = 0; c < 3; c++) mean[c] += destAnn[i * 3 + c];
    }
    nMean = nA;
  }
  for (let c = 0; c < 3; c++) mean[c] /= nMean;
  // scale-free scores: squared differences relative to the ring's brightness
  const norm = 1 / Math.max(1e-6, mean[0] * mean[0]);

  const cAnn = new Float32Array(3);
  const cInt = new Float32Array(nI * 3);
  let best: HealSourceResult | null = null;
  for (const k of RINGS) {
    for (let a = 0; a < ANGLES; a++) {
      const t = (a / ANGLES) * Math.PI * 2;
      const cx = dest.x + Math.cos(t) * r * k;
      const cy = dest.y + Math.sin(t) * r * k;
      const m = r * (1 + MARGIN);
      if (cx - m < 0 || cy - m < 0 || cx + m > w || cy + m > h) continue;
      if (Math.hypot(cx - dest.x, cy - dest.y) < 2 * r) continue;
      let blocked = false;
      for (const e of exclude) if (Math.hypot(cx - e.x, cy - e.y) < r + e.r) blocked = true;
      if (blocked) continue;

      // seam: candidate ring vs destination ring at the same angles
      let seam = 0;
      let nSeam = 0;
      for (let i = 0; i < nA; i++) {
        if (!destOk[i]) continue;
        const x = cx + pat.ann[i * 2] * r;
        const y = cy + pat.ann[i * 2 + 1] * r;
        // the mark itself (or another blemish) inside the candidate ring would be a false mismatch
        if (inExcluded(x, y, 1.05)) continue;
        feat(x, y, cAnn, 0);
        seam += dist2(cAnn, 0, destAnn, i * 3);
        nSeam++;
      }
      if (nSeam < nA * 0.25) continue;
      seam /= nSeam;

      // interior: must look like the clean ring around the mark, and be flat (no edges/features)
      const cm = [0, 0, 0];
      for (let j = 0; j < nI; j++) {
        feat(cx + pat.int[j * 2] * r, cy + pat.int[j * 2 + 1] * r, cInt, j * 3);
        cm[0] += cInt[j * 3];
        cm[1] += cInt[j * 3 + 1];
        cm[2] += cInt[j * 3 + 2];
      }
      const cmean = new Float32Array([cm[0] / nI, cm[1] / nI, cm[2] / nI]);
      let interior = 0;
      let variance = 0;
      for (let j = 0; j < nI; j++) {
        interior += dist2(cInt, j * 3, mean, 0);
        variance += dist2(cInt, j * 3, cmean, 0);
      }
      interior /= nI;
      variance /= nI;

      const base = (W_SEAM * seam + W_INTERIOR * interior + W_VARIANCE * variance) * norm;
      const score = (base + SCORE_FLOOR) * (1 + DIST_PENALTY * (k - RINGS[0]));
      if (!best || score < best.score) best = { x: cx, y: cy, score };
    }
  }
  return best;
}
