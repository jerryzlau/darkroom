import { constrainCrop, frameDims, type Geometry } from '@darkroom/core';
import { useRef } from 'react';
import { useDevelop } from '../state/develop';
import type { ViewMapper } from './DevelopCanvas';

type Handle = 'move' | 'rotate' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export function CropOverlay({ mapper }: { mapper: ViewMapper }) {
  const geo = useDevelop((s) => s.params.geometry);
  const drag = useRef<{ h: Handle; x: number; y: number; crop: Geometry['crop']; angle: number; a0: number } | null>(null);
  const lay = mapper.layout;
  const vr = lay.viewRect;
  const dpr = mapper.dpr;
  const src = { w: mapper.info.width, h: mapper.info.height };
  const f = frameDims(src, geo.rotate);
  const toCss = (px: number, py: number): [number, number] => [
    (lay.origin[0] + ((px - vr.x) / vr.w) * lay.cropPx[0] * lay.scale) / dpr,
    (lay.origin[1] + ((py - vr.y) / vr.h) * lay.cropPx[1] * lay.scale) / dpr,
  ];
  // R units per CSS px
  const ux = (vr.w / (lay.cropPx[0] * lay.scale)) * dpr;
  const uy = (vr.h / (lay.cropPx[1] * lay.scale)) * dpr;
  const c = geo.crop;
  const [x0, y0] = toCss(c.x, c.y);
  const [x1, y1] = toCss(c.x + c.w, c.y + c.h);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  const start = (h: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const r = (e.currentTarget as Element).closest('svg')!.getBoundingClientRect();
    const a0 = Math.atan2(e.clientY - r.top - cy, e.clientX - r.left - cx);
    drag.current = { h, x: e.clientX, y: e.clientY, crop: { ...c }, angle: geo.angle, a0 };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) * ux;
    const dy = (e.clientY - d.y) * uy;
    const s = useDevelop.getState();
    s.update((p) => {
      const g = p.geometry;
      if (d.h === 'rotate') {
        const r = (e.currentTarget as Element).getBoundingClientRect();
        const a = Math.atan2(e.clientY - r.top - cy, e.clientX - r.left - cx);
        let ang = d.angle + ((a - d.a0) * 180) / Math.PI;
        ang = Math.max(-45, Math.min(45, Math.round(ang * 10) / 10));
        g.angle = ang;
        g.crop = constrainCrop({ ...g, crop: d.crop }, src);
        return;
      }
      let { x, y, w, h } = d.crop;
      if (d.h === 'move') {
        x += dx;
        y += dy;
        g.crop = moveInside({ ...g, crop: { x, y, w, h } }, src, d.crop);
        return;
      }
      const minW = 32 / f.w;
      const minH = 32 / f.h;
      if (d.h.includes('e')) w = Math.max(minW, w + dx);
      if (d.h.includes('w')) {
        const nw = Math.max(minW, w - dx);
        x += w - nw;
        w = nw;
      }
      if (d.h.includes('s')) h = Math.max(minH, h + dy);
      if (d.h.includes('n')) {
        const nh = Math.max(minH, h - dy);
        y += h - nh;
        h = nh;
      }
      if (g.aspect) {
        // keep the pixel aspect ratio: derive the dependent side from the dragged one
        const horiz = d.h === 'e' || d.h === 'w';
        const vert = d.h === 'n' || d.h === 's';
        if (horiz || (!vert && Math.abs(dx) * f.w >= Math.abs(dy) * f.h)) {
          const nh = (w * f.w) / (g.aspect * f.h);
          if (d.h.includes('n')) y += h - nh;
          else if (horiz) y += (h - nh) / 2;
          h = nh;
        } else {
          const nw = (h * f.h * g.aspect) / f.w;
          if (d.h.includes('w')) x += w - nw;
          else if (vert) x += (w - nw) / 2;
          w = nw;
        }
      }
      if (x < 0 || y < 0 || x + w > 1 || y + h > 1) {
        // clamp to the frame
        if (x < 0) {
          w += x;
          x = 0;
        }
        if (y < 0) {
          h += y;
          y = 0;
        }
        w = Math.min(w, 1 - x);
        h = Math.min(h, 1 - y);
        if (g.aspect) {
          // shrink the other side too so the locked ratio survives the clamp
          if ((w * f.w) / (h * f.h) > g.aspect) {
            const nw = (h * f.h * g.aspect) / f.w;
            if (d.h.includes('w')) x += w - nw;
            w = nw;
          } else {
            const nh = (w * f.w) / (g.aspect * f.h);
            if (d.h.includes('n')) y += h - nh;
            h = nh;
          }
        }
      }
      g.crop = constrainCrop({ ...g, crop: { x, y, w, h } }, src);
    });
  };

  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    useDevelop.getState().commit('Crop');
  };

  const W = lay.canvas[0] / dpr;
  const H = lay.canvas[1] / dpr;
  const hs = 9;
  const handles: [Handle, number, number][] = [
    ['nw', x0, y0],
    ['n', cx, y0],
    ['ne', x1, y0],
    ['e', x1, cy],
    ['se', x1, y1],
    ['s', cx, y1],
    ['sw', x0, y1],
    ['w', x0, cy],
  ];
  const cursors: Record<string, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

  return (
    <svg className="overlay" width={W} height={H} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <path
        d={`M0,0H${W}V${H}H0Z M${x0},${y0}V${y1}H${x1}V${y0}Z`}
        fillRule="evenodd"
        fill="rgba(0,0,0,0.6)"
        style={{ cursor: 'alias' }}
        onPointerDown={start('rotate')}
      />
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="transparent" stroke="rgba(255,255,255,0.9)" strokeWidth={1} style={{ cursor: 'move' }} onPointerDown={start('move')} />
      {[1, 2].map((i) => (
        <g key={i} stroke="rgba(255,255,255,0.35)" strokeWidth={1} pointerEvents="none">
          <line x1={x0 + ((x1 - x0) * i) / 3} y1={y0} x2={x0 + ((x1 - x0) * i) / 3} y2={y1} />
          <line x1={x0} y1={y0 + ((y1 - y0) * i) / 3} x2={x1} y2={y0 + ((y1 - y0) * i) / 3} />
        </g>
      ))}
      {handles.map(([h, x, y]) => (
        <rect
          key={h}
          x={x - hs / 2}
          y={y - hs / 2}
          width={hs}
          height={hs}
          fill="#fff"
          stroke="#000"
          strokeWidth={0.5}
          style={{ cursor: cursors[h] }}
          onPointerDown={start(h)}
        />
      ))}
      <text x={cx} y={y1 + 18} textAnchor="middle" className="overlay-label">
        {Math.round(c.w * f.w)} × {Math.round(c.h * f.h)}
        {geo.angle !== 0 ? `  ·  ${geo.angle.toFixed(1)}°` : ''}
      </text>
    </svg>
  );
}

/** Translate a crop, stopping at the image boundary instead of shrinking it. */
function moveInside(g: Geometry, src: { w: number; h: number }, fallback: Geometry['crop']): Geometry['crop'] {
  const c = { ...g.crop };
  c.x = Math.min(Math.max(c.x, 0), 1 - c.w);
  c.y = Math.min(Math.max(c.y, 0), 1 - c.h);
  const constrained = constrainCrop({ ...g, crop: c }, src);
  if (Math.abs(constrained.w - c.w) < 1e-6 && Math.abs(constrained.h - c.h) < 1e-6) return constrained;
  // would need to shrink: try each axis separately
  for (const t of [{ ...c, y: fallback.y }, { ...c, x: fallback.x }]) {
    const k = constrainCrop({ ...g, crop: t }, src);
    if (Math.abs(k.w - t.w) < 1e-6) return k;
  }
  return fallback;
}
