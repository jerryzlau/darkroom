import type { Geometry } from './params';

/**
 * Coordinate systems
 *  - Source (S): the upright decoded image, uv in [0,1]^2.
 *  - Frame (F): S rotated by `rotate` x 90° clockwise, then flipped.
 *  - Rotated frame (R): F rotated by the straighten `angle` about its center,
 *    in the same normalized units as F (1 = F's width / height).
 *  - Crop (C): uv in [0,1]^2 inside the crop rectangle, which is axis-aligned in R.
 */

export interface Dims {
  w: number;
  h: number;
}

export function frameDims(src: Dims, rotate: number): Dims {
  return rotate % 2 === 1 ? { w: src.h, h: src.w } : { w: src.w, h: src.h };
}

/** Frame uv -> source uv */
export function frameToSource(geo: Geometry, fu: number, fv: number): [number, number] {
  let u = geo.flipH ? 1 - fu : fu;
  let v = geo.flipV ? 1 - fv : fv;
  switch (geo.rotate) {
    case 1:
      return [v, 1 - u];
    case 2:
      return [1 - u, 1 - v];
    case 3:
      return [1 - v, u];
    default:
      return [u, v];
  }
}

/** Source uv -> frame uv */
export function sourceToFrame(geo: Geometry, su: number, sv: number): [number, number] {
  let u: number, v: number;
  switch (geo.rotate) {
    case 1:
      [u, v] = [1 - sv, su];
      break;
    case 2:
      [u, v] = [1 - su, 1 - sv];
      break;
    case 3:
      [u, v] = [sv, 1 - su];
      break;
    default:
      [u, v] = [su, sv];
  }
  if (geo.flipH) u = 1 - u;
  if (geo.flipV) v = 1 - v;
  return [u, v];
}

/** Rotated-frame point (normalized) -> frame uv. */
export function rotatedToFrame(angleDeg: number, f: Dims, px: number, py: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const X = (px - 0.5) * f.w;
  const Y = (py - 0.5) * f.h;
  // inverse rotation (image appears rotated clockwise by +angle)
  const fx = c * X + s * Y;
  const fy = -s * X + c * Y;
  return [fx / f.w + 0.5, fy / f.h + 0.5];
}

export function frameToRotated(angleDeg: number, f: Dims, fu: number, fv: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const X = (fu - 0.5) * f.w;
  const Y = (fv - 0.5) * f.h;
  const px = c * X - s * Y;
  const py = s * X + c * Y;
  return [px / f.w + 0.5, py / f.h + 0.5];
}

export function cropToSource(geo: Geometry, src: Dims, cu: number, cv: number): [number, number] {
  const f = frameDims(src, geo.rotate);
  const px = geo.crop.x + cu * geo.crop.w;
  const py = geo.crop.y + cv * geo.crop.h;
  const [fu, fv] = rotatedToFrame(geo.angle, f, px, py);
  return frameToSource(geo, fu, fv);
}

export function sourceToCrop(geo: Geometry, src: Dims, su: number, sv: number): [number, number] {
  const f = frameDims(src, geo.rotate);
  const [fu, fv] = sourceToFrame(geo, su, sv);
  const [px, py] = frameToRotated(geo.angle, f, fu, fv);
  return [(px - geo.crop.x) / geo.crop.w, (py - geo.crop.y) / geo.crop.h];
}

/** Output pixel size of the crop at full resolution. */
export function cropPixelDims(geo: Geometry, src: Dims): Dims {
  const f = frameDims(src, geo.rotate);
  return { w: Math.max(1, Math.round(geo.crop.w * f.w)), h: Math.max(1, Math.round(geo.crop.h * f.h)) };
}

function insideFrame(fu: number, fv: number, eps = 1e-6): boolean {
  return fu >= -eps && fu <= 1 + eps && fv >= -eps && fv <= 1 + eps;
}

function cropInside(angle: number, f: Dims, c: Geometry['crop']): boolean {
  const corners: [number, number][] = [
    [c.x, c.y],
    [c.x + c.w, c.y],
    [c.x, c.y + c.h],
    [c.x + c.w, c.y + c.h],
  ];
  return corners.every(([x, y]) => insideFrame(...rotatedToFrame(angle, f, x, y)));
}

/**
 * Shrink (around its center) and if needed re-center a crop so that it lies
 * entirely inside the rotated image. Aspect ratio is preserved.
 */
export function constrainCrop(geo: Geometry, src: Dims): Geometry['crop'] {
  const f = frameDims(src, geo.rotate);
  let c = { ...geo.crop };
  c.w = Math.min(c.w, 1);
  c.h = Math.min(c.h, 1);
  if (geo.angle === 0) {
    c.x = Math.min(Math.max(c.x, 0), 1 - c.w);
    c.y = Math.min(Math.max(c.y, 0), 1 - c.h);
    return c;
  }
  if (cropInside(geo.angle, f, c)) return c;
  // first try to translate towards the center
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const nx = cx + (0.5 - cx) * t;
    const ny = cy + (0.5 - cy) * t;
    const moved = { ...c, x: nx - c.w / 2, y: ny - c.h / 2 };
    if (cropInside(geo.angle, f, moved)) return moved;
  }
  // then shrink around the image center
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const s = (lo + hi) / 2;
    const test = { x: 0.5 - (c.w * s) / 2, y: 0.5 - (c.h * s) / 2, w: c.w * s, h: c.h * s };
    if (cropInside(geo.angle, f, test)) lo = s;
    else hi = s;
  }
  c = { x: 0.5 - (c.w * lo) / 2, y: 0.5 - (c.h * lo) / 2, w: c.w * lo, h: c.h * lo };
  return c;
}

/** Largest centered crop of the given pixel aspect (or the frame aspect) for an angle. */
export function maxCrop(geo: Geometry, src: Dims, aspect: number | null): Geometry['crop'] {
  const f = frameDims(src, geo.rotate);
  const a = aspect ?? f.w / f.h;
  // in normalized units, w_n * f.w / (h_n * f.h) = a
  let w = 1;
  let h = (w * f.w) / (a * f.h);
  if (h > 1) {
    h = 1;
    w = (a * f.h) / f.w;
  }
  return constrainCrop({ ...geo, crop: { x: 0.5 - w / 2, y: 0.5 - h / 2, w, h } }, src);
}

/** Bounding box of the rotated frame in R coordinates (for crop mode display). */
export function rotatedBounds(geo: Geometry, src: Dims): Geometry['crop'] {
  const f = frameDims(src, geo.rotate);
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([u, v]) => frameToRotated(geo.angle, f, u, v));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** Apply a new aspect ratio to the current crop, keeping its center. */
export function cropWithAspect(geo: Geometry, src: Dims, aspect: number | null): Geometry['crop'] {
  if (aspect === null) return geo.crop;
  const f = frameDims(src, geo.rotate);
  const c = geo.crop;
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  const areaPx = c.w * f.w * (c.h * f.h);
  let wPx = Math.sqrt(areaPx * aspect);
  let hPx = wPx / aspect;
  let w = wPx / f.w;
  let h = hPx / f.h;
  const scale = Math.min(1, 1 / w, 1 / h);
  w *= scale;
  h *= scale;
  return constrainCrop({ ...geo, crop: { x: cx - w / 2, y: cy - h / 2, w, h } }, src);
}

export const ASPECT_PRESETS: { label: string; value: number | null }[] = [
  { label: 'Original', value: -1 },
  { label: 'Free', value: null },
  { label: '1 : 1', value: 1 },
  { label: '4 : 5', value: 4 / 5 },
  { label: '5 : 4', value: 5 / 4 },
  { label: '2 : 3', value: 2 / 3 },
  { label: '3 : 2', value: 3 / 2 },
  { label: '3 : 4', value: 3 / 4 },
  { label: '4 : 3', value: 4 / 3 },
  { label: '9 : 16', value: 9 / 16 },
  { label: '16 : 9', value: 16 / 9 },
];
