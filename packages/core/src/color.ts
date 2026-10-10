/**
 * Color math shared by the UI and mirrored in the shaders.
 *
 * Pipeline color model:
 *   camera RGB (linear) --WB multipliers--> balanced camera RGB
 *     --camToPro--> linear ProPhoto RGB (D50), the working space
 *     --tone/color ops--> --proToOut--> output space (sRGB / Display P3 / ProPhoto).
 *
 * Non-raw sources are treated as a "camera" whose space is linear sRGB or
 * linear Display P3, so white balance works the same way for every file.
 */

export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Vec3 = [number, number, number];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      r[i * 3 + j] = s;
    }
  return r;
}

export function mulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  const s = 1 / det;
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ];
}

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// White points (XYZ, Y=1)
export const D65: Vec3 = [0.95047, 1.0, 1.08883];
export const D50: Vec3 = [0.96422, 1.0, 0.82521];

/** Linear sRGB (D65) -> XYZ */
export const SRGB_TO_XYZ: Mat3 = [
  0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041,
];
/** Linear Display P3 (D65) -> XYZ */
export const P3_TO_XYZ: Mat3 = [
  0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0.0, 0.0451134, 1.0439444,
];
/** Linear ProPhoto (D50) -> XYZ (D50) */
export const PROPHOTO_TO_XYZ: Mat3 = [
  0.7976749, 0.1351917, 0.0313534, 0.2880402, 0.7118741, 0.0000857, 0.0, 0.0, 0.82521,
];

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/** Bradford chromatic adaptation matrix from white `src` to white `dst`. */
export function bradford(src: Vec3, dst: Vec3): Mat3 {
  const s = mulVec(BRADFORD, src);
  const d = mulVec(BRADFORD, dst);
  const scale: Mat3 = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
  return mul3(inv3(BRADFORD), mul3(scale, BRADFORD));
}

const D65_TO_D50 = bradford(D65, D50);
const D50_TO_D65 = bradford(D50, D65);

export const XYZ_TO_SRGB = inv3(SRGB_TO_XYZ);
export const XYZ_TO_P3 = inv3(P3_TO_XYZ);
export const XYZ_TO_PROPHOTO = inv3(PROPHOTO_TO_XYZ);

/** Linear sRGB -> linear ProPhoto (with D65->D50 adaptation). */
export const SRGB_TO_PRO = mul3(XYZ_TO_PROPHOTO, mul3(D65_TO_D50, SRGB_TO_XYZ));
export const P3_TO_PRO = mul3(XYZ_TO_PROPHOTO, mul3(D65_TO_D50, P3_TO_XYZ));
export const PRO_TO_SRGB = inv3(SRGB_TO_PRO);
export const PRO_TO_P3 = inv3(P3_TO_PRO);
export { D50_TO_D65, D65_TO_D50 };

/** Luma weights for ProPhoto primaries (Y row of PROPHOTO_TO_XYZ). */
export const PRO_LUMA: Vec3 = [0.2880402, 0.7118741, 0.0000857];

export type OutputSpace = 'srgb' | 'p3' | 'prophoto';

export function proToOutput(space: OutputSpace): Mat3 {
  return space === 'srgb' ? PRO_TO_SRGB : space === 'p3' ? PRO_TO_P3 : IDENTITY;
}

// ---------------------------------------------------------------------------
// Transfer functions
// ---------------------------------------------------------------------------

export function srgbEncode(x: number): number {
  if (x <= 0.0031308) return 12.92 * x;
  return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function srgbDecode(x: number): number {
  if (x <= 0.04045) return x / 12.92;
  return Math.pow((x + 0.055) / 1.055, 2.4);
}

// ---------------------------------------------------------------------------
// Correlated color temperature
// ---------------------------------------------------------------------------

/** Planckian locus chromaticity (Kim et al. cubic spline), valid 1667K..25000K. */
export function planckianXY(T: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, T));
  const t1 = 1e3 / t;
  const t2 = t1 * t1;
  const t3 = t2 * t1;
  let x: number;
  if (t <= 4000) x = -0.2661239 * t3 - 0.234358 * t2 + 0.8776956 * t1 + 0.17991;
  else x = -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t1 + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (t <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  // Extend above 25000K by linear extrapolation in mired space.
  if (T > 25000) {
    const [xa, ya] = planckianXY(24000);
    const [xb, yb] = planckianXY(25000);
    const k = (1e6 / T - 1e6 / 25000) / (1e6 / 25000 - 1e6 / 24000);
    return [xb + (xb - xa) * k, yb + (yb - ya) * k];
  }
  return [x, y];
}

/** CIE 1960 uv from xy */
function xyToUv(x: number, y: number): [number, number] {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
}

function uvToXy(u: number, v: number): [number, number] {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

/** Lightroom-style tint scale: 1 tint unit = this much Duv. */
const TINT_SCALE = 1 / 3000;

/**
 * Chromaticity of an illuminant at temperature T with a tint offset.
 * Positive tint corresponds to a greener illuminant, which the white balance
 * compensates with magenta, matching Lightroom's slider direction.
 */
export function tempTintToXY(T: number, tint: number): [number, number] {
  const [x, y] = planckianXY(T);
  const [u, v] = xyToUv(x, y);
  // normal to the locus: perpendicular to the tangent in uv
  const [x2, y2] = planckianXY(T * 1.01);
  const [u2, v2] = xyToUv(x2, y2);
  let du = u2 - u;
  let dv = v2 - v;
  const len = Math.hypot(du, dv) || 1;
  du /= len;
  dv /= len;
  // Rotate tangent by +90°; with temperature increasing the tangent points
  // roughly towards -u; the +90° rotation points to +v (greener).
  let nu = -dv;
  let nv = du;
  if (nv < 0) {
    nu = -nu;
    nv = -nv;
  }
  const duv = tint * TINT_SCALE;
  return uvToXy(u + nu * duv, v + nv * duv);
}

/** Inverse of tempTintToXY by search in mired space. */
export function xyToTempTint(x: number, y: number): { temp: number; tint: number } {
  const [u, v] = xyToUv(x, y);
  const dist = (T: number) => {
    const [px, py] = planckianXY(T);
    const [pu, pv] = xyToUv(px, py);
    return Math.hypot(u - pu, v - pv);
  };
  // coarse search over mireds 20..600 (50000K..1667K)
  let best = 6500;
  let bestD = Infinity;
  for (let m = 20; m <= 600; m += 2) {
    const T = 1e6 / m;
    const d = dist(T);
    if (d < bestD) {
      bestD = d;
      best = T;
    }
  }
  // refine with golden-section in mireds
  let lo = 1e6 / best - 2;
  let hi = 1e6 / best + 2;
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) * 0.382;
    const m2 = lo + (hi - lo) * 0.618;
    if (dist(1e6 / m1) < dist(1e6 / m2)) hi = m2;
    else lo = m1;
  }
  const T = 1e6 / ((lo + hi) / 2);
  // signed distance: refine tint so that tempTintToXY(T, tint) ~ (x, y)
  const [px, py] = planckianXY(T);
  const [pu, pv] = xyToUv(px, py);
  const [qx, qy] = tempTintToXY(T, 1);
  const [qu, qv] = xyToUv(qx, qy);
  const nu = qu - pu;
  const nv = qv - pv;
  const tint = ((u - pu) * nu + (v - pv) * nv) / (nu * nu + nv * nv);
  return { temp: T, tint };
}

export function xyToXYZ(x: number, y: number): Vec3 {
  return [x / y, 1, (1 - x - y) / y];
}

// ---------------------------------------------------------------------------
// Source color description and white balance
// ---------------------------------------------------------------------------

export interface SourceColor {
  /** XYZ (D65-calibrated) -> camera RGB matrix, row-major. */
  xyzToCam: Mat3;
  /** As-shot WB multipliers in camera space (green = 1). */
  asShotMul: Vec3;
  isRaw: boolean;
}

export function srgbSourceColor(space: 'srgb' | 'p3' = 'srgb'): SourceColor {
  return { xyzToCam: space === 'p3' ? XYZ_TO_P3 : XYZ_TO_SRGB, asShotMul: [1, 1, 1], isRaw: false };
}

/**
 * Camera -> linear ProPhoto for WB-balanced camera values.
 * Rows of camRgb = xyzToCam * sRGB->XYZ are normalized so that a balanced
 * neutral (1,1,1) maps to sRGB white (dcraw convention).
 */
export function camToPro(src: SourceColor): Mat3 {
  const camRgb = mul3(src.xyzToCam, SRGB_TO_XYZ);
  const n = [...camRgb] as Mat3;
  for (let r = 0; r < 3; r++) {
    const s = n[r * 3] + n[r * 3 + 1] + n[r * 3 + 2];
    for (let c = 0; c < 3; c++) n[r * 3 + c] = s !== 0 ? n[r * 3 + c] / s : 0;
  }
  const rgbCam = inv3(n);
  return mul3(SRGB_TO_PRO, rgbCam);
}

/** WB multipliers (green normalized to 1) for an illuminant temperature/tint. */
export function multipliersFor(src: SourceColor, temp: number, tint: number): Vec3 {
  const [x, y] = tempTintToXY(temp, tint);
  const cam = mulVec(src.xyzToCam, xyToXYZ(x, y));
  const m: Vec3 = [1 / Math.max(cam[0], 1e-6), 1 / Math.max(cam[1], 1e-6), 1 / Math.max(cam[2], 1e-6)];
  return [m[0] / m[1], 1, m[2] / m[1]];
}

/** The temperature/tint that corresponds to the as-shot multipliers. */
export function asShotTempTint(src: SourceColor): { temp: number; tint: number } {
  const neutral: Vec3 = [1 / src.asShotMul[0], 1 / src.asShotMul[1], 1 / src.asShotMul[2]];
  const XYZ = mulVec(inv3(src.xyzToCam), neutral);
  const s = XYZ[0] + XYZ[1] + XYZ[2];
  const r = xyToTempTint(XYZ[0] / s, XYZ[1] / s);
  return { temp: Math.round(r.temp), tint: Math.round(r.tint) };
}

/**
 * WB multipliers to use given params. In as-shot mode use the camera's own
 * multipliers exactly so that the round trip is lossless for JPEGs.
 */
export function wbMultipliers(src: SourceColor, wb: { mode: string; temp: number; tint: number }): Vec3 {
  if (wb.mode === 'asShot') return [...src.asShotMul] as Vec3;
  return multipliersFor(src, wb.temp, wb.tint);
}

/** Multipliers that neutralize a sampled camera-space color (eyedropper). */
export function tempTintFromNeutral(src: SourceColor, camRgb: Vec3): { temp: number; tint: number } {
  const XYZ = mulVec(inv3(src.xyzToCam), camRgb);
  const s = XYZ[0] + XYZ[1] + XYZ[2];
  if (s <= 0) return { temp: 6500, tint: 0 };
  const r = xyToTempTint(XYZ[0] / s, XYZ[1] / s);
  return {
    temp: Math.round(Math.min(50000, Math.max(2000, r.temp))),
    tint: Math.round(Math.min(150, Math.max(-150, r.tint))),
  };
}

// ---------------------------------------------------------------------------
// Hue helpers
// ---------------------------------------------------------------------------

export function hsvToRgb(h: number, s: number, v: number): Vec3 {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

export function rgbToHsv(r: number, g: number, b: number): Vec3 {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max > 0 ? d / max : 0, max];
}

/** Temperature slider: map 0..1 position to Kelvin with perceptual (mired) spacing. */
export function tempFromSlider(t: number): number {
  const mMin = 1e6 / 50000;
  const mMax = 1e6 / 2000;
  return 1e6 / (mMax + (mMin - mMax) * t);
}

export function sliderFromTemp(T: number): number {
  const mMin = 1e6 / 50000;
  const mMax = 1e6 / 2000;
  return (1e6 / T - mMax) / (mMin - mMax);
}
