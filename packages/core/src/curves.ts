import type { EditParams, Pt } from './params';
import { isCurveIdentity } from './params';

/**
 * Monotone cubic interpolation (Fritsch–Carlson). Returns a function on [0,1].
 * Points must be sorted by x. Values outside the point range are clamped to
 * the end points' y, as Lightroom's point curve does.
 */
export function monotoneSpline(points: Pt[]): (x: number) => number {
  const pts = dedupe(points);
  const n = pts.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-9));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else m[i] = (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}

function dedupe(points: Pt[]): Pt[] {
  const s = [...points].sort((a, b) => a[0] - b[0]);
  const out: Pt[] = [];
  for (const p of s) {
    if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-6) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/**
 * Parametric (region) curve. Each region slider pushes the curve up or down
 * with a smooth bump centered in its zone. Zero everywhere is the identity.
 */
export function parametricCurve(tc: EditParams['toneCurve']): (x: number) => number {
  const { highlights, lights, darks, shadows } = tc.region;
  if (!highlights && !lights && !darks && !shadows) return (x) => x;
  const [s0, s1, s2] = tc.splits.map((s) => s / 100);
  const zones: [number, number, number][] = [
    // [amount, center, halfWidth]
    [shadows, s0 / 2, s0 / 2 + 0.08],
    [darks, (s0 + s1) / 2, (s1 - s0) / 2 + 0.1],
    [lights, (s1 + s2) / 2, (s2 - s1) / 2 + 0.1],
    [highlights, (s2 + 1) / 2, (1 - s2) / 2 + 0.08],
  ];
  const raw = (x: number) => {
    let y = x;
    for (const [amt, c, hw] of zones) {
      if (!amt) continue;
      const t = (x - c) / hw;
      if (Math.abs(t) >= 1) continue;
      const bump = (1 - t * t) * (1 - t * t); // smooth, zero slope at edges
      // scale so the curve can't reach outside [0,1] at the ends
      const endFade = Math.min(1, x * 6, (1 - x) * 6);
      y += (amt / 100) * 0.22 * bump * endFade;
    }
    return y;
  };
  // Build a monotone, clamped table
  const N = 512;
  const table = new Float64Array(N + 1);
  let prev = 0;
  for (let i = 0; i <= N; i++) {
    const v = Math.min(1, Math.max(0, raw(i / N)));
    prev = i === 0 ? v : Math.max(prev, v);
    table[i] = prev;
  }
  return (x: number) => {
    const f = Math.min(1, Math.max(0, x)) * N;
    const i = Math.min(N - 1, Math.floor(f));
    const t = f - i;
    return table[i] * (1 - t) + table[i + 1] * t;
  };
}

export const CURVE_LUT_SIZE = 1024;

/**
 * Bake the full tone curve (parametric then master point curve then per
 * channel point curves) into an RGBA float table of CURVE_LUT_SIZE entries.
 * Returns null when the curve is the identity so the shader can skip it.
 */
export function bakeCurveLUT(tc: EditParams['toneCurve']): Float32Array | null {
  const regionIdentity =
    !tc.region.highlights && !tc.region.lights && !tc.region.darks && !tc.region.shadows;
  const { rgb, r, g, b } = tc.points;
  if (
    regionIdentity &&
    isCurveIdentity(rgb) &&
    isCurveIdentity(r) &&
    isCurveIdentity(g) &&
    isCurveIdentity(b)
  )
    return null;
  const par = parametricCurve(tc);
  const master = monotoneSpline(rgb);
  const cr = monotoneSpline(r);
  const cg = monotoneSpline(g);
  const cb = monotoneSpline(b);
  const out = new Float32Array(CURVE_LUT_SIZE * 4);
  for (let i = 0; i < CURVE_LUT_SIZE; i++) {
    const x = i / (CURVE_LUT_SIZE - 1);
    const m = master(par(x));
    out[i * 4] = cr(m);
    out[i * 4 + 1] = cg(m);
    out[i * 4 + 2] = cb(m);
    out[i * 4 + 3] = 1;
  }
  return out;
}
