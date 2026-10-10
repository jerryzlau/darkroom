import {
  ellipsePolygon,
  isAllZero,
  MAX_SHAPE_POINTS,
  newMask,
  polygonBounds,
  rectPolygon,
  simplifyPolyline,
  type Mask,
  type Pt,
} from '@darkroom/core';
import { useRef, useState } from 'react';
import { MAX_MASKS } from '../engine/shaders';
import { useDevelop } from '../state/develop';
import { toast } from '../state/toast';
import type { ViewMapper } from './DevelopCanvas';

const clampUv = (v: number) => Math.min(2, Math.max(-1, v));

/** Next free "Selection N" index (0-based, as newMask expects). */
function nextSelectionIndex(masks: Mask[]): number {
  const used = new Set(masks.map((m) => m.name));
  let i = 0;
  while (used.has(`Selection ${i + 1}`)) i++;
  return i;
}

function pathD(pts: Pt[]): string {
  if (!pts.length) return '';
  return `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`;
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Store a polygon drawn in CSS px as a selection: replace the active shape
 * mask's polygon while it has no adjustments yet, otherwise add a new one.
 */
export function commitSelection(mapper: ViewMapper, css: Pt[]) {
  const uv = css.map(([x, y]) => {
    const [u, v] = mapper.toSource(x, y);
    return [clampUv(u), clampUv(v)] as Pt;
  });
  const s = useDevelop.getState();
  const masks = s.params.masks;
  const idx = masks.findIndex((m) => m.id === s.activeMaskId);
  const act = idx >= 0 ? masks[idx] : null;
  if (act && act.kind === 'shape' && isAllZero(act.adj)) {
    s.setAndCommit((p) => {
      p.masks[idx].shape.points = uv;
    }, 'Edit Selection');
    s.setView({ overlayMask: idx, overlayInvert: act.invert });
    return;
  }
  if (masks.length >= MAX_MASKS) {
    toast(`Up to ${MAX_MASKS} masks per photo`, 'warn');
    return;
  }
  const m = newMask('shape', nextSelectionIndex(masks));
  m.shape = { points: uv, feather: s.select.feather };
  s.setAndCommit((p) => {
    p.masks.push(m);
  }, 'New Selection');
  s.setActiveMask(m.id);
  s.setView({ overlayMask: masks.length, overlayInvert: false });
}

export function SelectOverlay({ mapper }: { mapper: ViewMapper }) {
  const masks = useDevelop((s) => s.params.masks);
  const activeId = useDevelop((s) => s.activeMaskId);
  const mode = useDevelop((s) => s.select.mode);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ start: Pt; pts: Pt[] } | null>(null);
  const [preview, setPreview] = useState<Pt[] | null>(null);

  const W = mapper.layout.canvas[0] / mapper.dpr;
  const H = mapper.layout.canvas[1] / mapper.dpr;

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const marquee = (start: Pt, end: Pt, shift: boolean): Pt[] => {
    let b = end;
    if (shift) {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      b = [start[0] + (dx < 0 ? -side : side), start[1] + (dy < 0 ? -side : side)];
    }
    return mode === 'rect' ? rectPolygon(start, b) : ellipsePolygon(start, b, 64);
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = local(e);
    drag.current = { start: p, pts: [p] };
    setPreview(null);
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = local(e);
    if (mode === 'lasso') {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) {
        d.pts.push(p);
        setPreview([...d.pts]);
      }
    } else {
      d.pts = marquee(d.start, p, e.shiftKey);
      setPreview(d.pts);
    }
  };

  const click = (p: Pt) => {
    // a click selects the topmost selection under the pointer, or deselects
    const s = useDevelop.getState();
    const ms = s.params.masks;
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      if (m.kind !== 'shape' || m.shape.points.length < 3) continue;
      const poly = m.shape.points.map(([u, v]) => mapper.toScreen(u, v) as Pt);
      if (pointInPolygon(p, poly)) {
        s.setActiveMask(m.id);
        if (s.view.overlayMask >= 0) s.setView({ overlayMask: i, overlayInvert: m.invert });
        return;
      }
    }
    if (s.activeMaskId) {
      s.setActiveMask(null);
      s.setView({ overlayMask: -1 });
    }
  };

  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setPreview(null);
    if (e.type === 'pointercancel') return;
    let pts = d.pts;
    if (mode === 'lasso') {
      let eps = 1.5;
      pts = simplifyPolyline(pts, eps);
      while (pts.length > MAX_SHAPE_POINTS) {
        eps *= 2;
        pts = simplifyPolyline(pts, eps);
      }
    }
    const b = polygonBounds(pts);
    if (pts.length < 3 || Math.max(b.maxX - b.minX, b.maxY - b.minY) < 4) {
      click(d.start);
      return;
    }
    commitSelection(mapper, pts);
  };

  const screen = (m: Mask): Pt[] => m.shape.points.map(([u, v]) => mapper.toScreen(u, v) as Pt);
  const shapes = masks.filter((m) => m.kind === 'shape' && m.shape.points.length >= 3);
  const active = shapes.find((m) => m.id === activeId) ?? null;

  return (
    <svg
      ref={svgRef}
      className="overlay"
      width={W}
      height={H}
      style={{ cursor: 'crosshair' }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <rect x={0} y={0} width={W} height={H} fill="transparent" />
      <g pointerEvents="none">
        {shapes
          .filter((m) => m.id !== activeId)
          .map((m) => (
            <path key={m.id} d={pathD(screen(m))} className="sel-other">
              <title>{m.name}</title>
            </path>
          ))}
        {active && !preview && (
          <g className="ants">
            <path d={pathD(screen(active))} className="ants-under" />
            <path d={pathD(screen(active))} className="ants-over" />
          </g>
        )}
        {preview && preview.length > 1 && (
          <g className="ants">
            <path d={mode === 'lasso' ? `M${preview.map(([x, y]) => `${x},${y}`).join('L')}` : pathD(preview)} className="ants-under" />
            <path d={mode === 'lasso' ? `M${preview.map(([x, y]) => `${x},${y}`).join('L')}` : pathD(preview)} className="ants-over" />
          </g>
        )}
      </g>
    </svg>
  );
}
