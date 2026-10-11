/**
 * Pure geometry helpers for selection shapes (lasso, rectangle and ellipse
 * marquees). Coordinates are plain [x, y] pairs; callers decide the space
 * (CSS pixels while dragging, source UV once stored in a mask).
 */
import type { LocalAdjustments, Mask, Pt } from './params';

/** Axis-aligned rectangle with corners a and b, as a clockwise 4-point polygon. */
export function rectPolygon(a: Pt, b: Pt): Pt[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Ellipse inscribed in the rectangle spanned by a and b, sampled with n vertices. */
export function ellipsePolygon(a: Pt, b: Pt, n = 64): Pt[] {
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  const rx = Math.abs(b[0] - a[0]) / 2;
  const ry = Math.abs(b[1] - a[1]) / 2;
  const count = Math.max(3, Math.floor(n));
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Ramer–Douglas–Peucker polyline simplification (iterative, no recursion).
 * Keeps the endpoints and every vertex further than eps from the simplified
 * line. eps <= 0 returns a copy.
 */
export function simplifyPolyline(points: Pt[], eps: number): Pt[] {
  if (points.length <= 2 || !(eps > 0)) return points.map(([x, y]) => [x, y]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > eps) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push([points[i][0], points[i][1]]);
  return out;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Axis-aligned bounds of a point list; all zeros for an empty list. */
export function polygonBounds(points: Pt[]): Bounds {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Center of the bounding box (stable for pins/labels, unlike the vertex mean). */
export function polygonCenter(points: Pt[]): Pt {
  const b = polygonBounds(points);
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

/** True when every local adjustment is zero (the mask has no visible effect yet). */
export function isAllZero(adj: LocalAdjustments): boolean {
  return Object.values(adj).every((v) => v === 0);
}

/**
 * Source-UV bounds of the area a mask can affect, clamped to [0,1]. Null for
 * linear gradients (unbounded), empty masks, or a box that clamps to nothing.
 */
export function maskBounds(m: Mask, info: { width: number; height: number }): Bounds | null {
  const long = Math.max(info.width, info.height);
  const sx = long / info.width;
  const sy = long / info.height;
  let b: Bounds | null = null;
  if (m.kind === 'shape') {
    if (m.shape.points.length < 3) return null;
    const pb = polygonBounds(m.shape.points);
    const fx = m.shape.feather * sx;
    const fy = m.shape.feather * sy;
    b = { minX: pb.minX - fx, minY: pb.minY - fy, maxX: pb.maxX + fx, maxY: pb.maxY + fy };
  } else if (m.kind === 'brush') {
    for (const st of m.brush.strokes) {
      if (st.erase || !st.points.length) continue;
      const pb = polygonBounds(st.points);
      const px = st.size * sx;
      const py = st.size * sy;
      const sb = { minX: pb.minX - px, minY: pb.minY - py, maxX: pb.maxX + px, maxY: pb.maxY + py };
      b = b
        ? { minX: Math.min(b.minX, sb.minX), minY: Math.min(b.minY, sb.minY), maxX: Math.max(b.maxX, sb.maxX), maxY: Math.max(b.maxY, sb.maxY) }
        : sb;
    }
    if (!b) return null;
  } else if (m.kind === 'radial') {
    const { cx, cy, rx, ry, angle } = m.radial;
    const a = (angle * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const hx = Math.sqrt((rx * c) ** 2 + (ry * s) ** 2) * sx;
    const hy = Math.sqrt((rx * s) ** 2 + (ry * c) ** 2) * sy;
    b = { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
  } else {
    return null;
  }
  const cl = (v: number) => Math.min(1, Math.max(0, v));
  const out = { minX: cl(b.minX), minY: cl(b.minY), maxX: cl(b.maxX), maxY: cl(b.maxY) };
  if (!(out.maxX > out.minX) || !(out.maxY > out.minY)) return null;
  return out;
}
