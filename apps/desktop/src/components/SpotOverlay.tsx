import { newMaskId, type Spot } from '@darkroom/core';
import { useRef, useState } from 'react';
import { useDevelop } from '../state/develop';
import type { ViewMapper } from './DevelopCanvas';

/** Pick a source near the destination that stays inside the image. */
export function autoSource(x: number, y: number, r: number, info: { width: number; height: number }): [number, number] {
  const long = Math.max(info.width, info.height);
  const rx = (r * long) / info.width;
  const ry = (r * long) / info.height;
  const dirs = [0, Math.PI, -Math.PI / 2, Math.PI / 2, -Math.PI / 4, (-3 * Math.PI) / 4, Math.PI / 4, (3 * Math.PI) / 4];
  for (const k of [2.4, 3.2, 4.5]) {
    for (const a of dirs) {
      const sx = x + Math.cos(a) * rx * k;
      const sy = y + Math.sin(a) * ry * k;
      if (sx - rx * 1.2 >= 0 && sx + rx * 1.2 <= 1 && sy - ry * 1.2 >= 0 && sy + ry * 1.2 <= 1) return [sx, sy];
    }
  }
  return [Math.min(1, x + rx * 2.4), y];
}

export function SpotOverlay({ mapper }: { mapper: ViewMapper }) {
  const spots = useDevelop((s) => s.params.spots);
  const activeId = useDevelop((s) => s.activeSpotId);
  const settings = useDevelop((s) => s.spot);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; which: 'dest' | 'src'; start: [number, number]; orig: Spot } | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const W = mapper.layout.canvas[0] / mapper.dpr;
  const H = mapper.layout.canvas[1] / mapper.dpr;
  const long = Math.max(mapper.info.width, mapper.info.height);
  const rPx = (r: number) => r * long * mapper.pxScale;
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const b = svgRef.current!.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };
  const st = useDevelop.getState;

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = local(e);
    const [u, v] = mapper.toSource(p[0], p[1]);
    if (u < 0 || v < 0 || u > 1 || v > 1) return;
    const sp = st().spot;
    const [sx, sy] = autoSource(u, v, sp.r, mapper.info);
    const spot: Spot = { id: newMaskId(), mode: sp.mode, x: u, y: v, sx, sy, r: sp.r, feather: sp.feather, opacity: sp.opacity };
    st().setAndCommit((q) => q.spots.push(spot), sp.mode === 'heal' ? 'Heal Spot' : 'Clone Spot');
    st().setActiveSpot(spot.id);
  };

  const startDrag = (s: Spot, which: 'dest' | 'src') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    st().setActiveSpot(s.id);
    drag.current = { id: s.id, which, start: local(e), orig: { ...s } };
  };

  const onMove = (e: React.PointerEvent) => {
    const p = local(e);
    setHover(p);
    const d = drag.current;
    if (!d) return;
    const [u0, v0] = mapper.toSource(d.start[0], d.start[1]);
    const [u1, v1] = mapper.toSource(p[0], p[1]);
    st().update((q) => {
      const s = q.spots.find((x) => x.id === d.id);
      if (!s) return;
      if (d.which === 'dest') {
        s.x = d.orig.x + u1 - u0;
        s.y = d.orig.y + v1 - v0;
      } else {
        s.sx = d.orig.sx + u1 - u0;
        s.sy = d.orig.sy + v1 - v0;
      }
    });
  };

  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    st().commit('Move Spot');
  };

  return (
    <svg ref={svgRef} className="overlay" width={W} height={H} style={{ cursor: 'crosshair' }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setHover(null)}>
      {spots.map((s) => {
        const [dx, dy] = mapper.toScreen(s.x, s.y);
        const [sx, sy] = mapper.toScreen(s.sx, s.sy);
        const r = rPx(s.r);
        const active = s.id === activeId;
        return (
          <g key={s.id}>
            {active && (
              <>
                <line x1={sx} y1={sy} x2={dx} y2={dy} stroke="rgba(255,255,255,0.6)" strokeDasharray="4 3" pointerEvents="none" />
                <circle cx={sx} cy={sy} r={r} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.7)" strokeDasharray="4 3" strokeWidth={1.5} style={{ cursor: 'move' }} onPointerDown={startDrag(s, 'src')} />
              </>
            )}
            <circle cx={dx} cy={dy} r={r} fill="rgba(255,255,255,0.04)" stroke={active ? '#fff' : 'rgba(255,255,255,0.55)'} strokeWidth={active ? 1.8 : 1} style={{ cursor: 'move' }} onPointerDown={startDrag(s, 'dest')} />
          </g>
        );
      })}
      {hover && !drag.current && <circle cx={hover[0]} cy={hover[1]} r={rPx(settings.r)} fill="none" stroke="rgba(224,180,106,0.8)" strokeWidth={1} pointerEvents="none" />}
    </svg>
  );
}
