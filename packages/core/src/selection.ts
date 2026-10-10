/**
 * Pure geometry helpers for selection shapes (lasso, rectangle and ellipse
 * marquees). Coordinates are plain [x, y] pairs; callers decide the space
 * (CSS pixels while dragging, source UV once stored in a mask).
 */
import type { LocalAdjustments, Pt } from './params';

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
