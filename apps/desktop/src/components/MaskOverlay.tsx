import { polygonCenter, type Mask, type Pt } from '@darkroom/core';
import { useEffect, useRef, useState } from 'react';
import { useDevelop } from '../state/develop';
import type { ViewMapper } from './DevelopCanvas';

type DragKind = 'lin0' | 'lin1' | 'linMid' | 'radCenter' | 'radX' | 'radY' | 'brush';

export function MaskOverlay({ mapper }: { mapper: ViewMapper }) {
  const masks = useDevelop((s) => s.params.masks);
  const activeId = useDevelop((s) => s.activeMaskId);
  const brush = useDevelop((s) => s.brush);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: DragKind; start: [number, number]; mask: Mask; maskIndex: number } | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [alt, setAlt] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => setAlt(e.altKey);
    window.addEventListener('keydown', k);
    window.addEventListener('keyup', k);
    return () => {
      window.removeEventListener('keydown', k);
      window.removeEventListener('keyup', k);
    };
  }, []);

  const W = mapper.layout.canvas[0] / mapper.dpr;
  const H = mapper.layout.canvas[1] / mapper.dpr;
  const long = Math.max(mapper.info.width, mapper.info.height);
  const active = masks.find((m) => m.id === activeId) ?? null;
  const activeIndex = masks.findIndex((m) => m.id === activeId);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const begin = (kind: DragKind) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !active) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = local(e);
    drag.current = { kind, start: p, mask: structuredClone(active), maskIndex: activeIndex };
    if (kind === 'brush') {
      const [u, v] = mapper.toSource(p[0], p[1]);
      const b = useDevelop.getState().brush;
      useDevelop.getState().update((pp) => {
        pp.masks[activeIndex].brush.strokes.push({
          points: [[u, v]],
          size: b.size,
          feather: b.feather,
          flow: b.flow,
          erase: b.erase !== e.altKey,
        });
      });
    }
  };

  const move = (e: React.PointerEvent) => {
    const p = local(e);
    setCursor(p);
    const d = drag.current;
    if (!d) return;
    const [u, v] = mapper.toSource(p[0], p[1]);
    const s = useDevelop.getState();
    s.update((pp) => {
      const m = pp.masks[d.maskIndex];
      if (!m) return;
      if (d.kind === 'brush') {
        const st = m.brush.strokes[m.brush.strokes.length - 1];
        const last = st.points[st.points.length - 1];
        const minStep = (st.size * 0.12 * long) / Math.max(mapper.info.width, 1);
        if (Math.hypot(u - last[0], (v - last[1]) * (mapper.info.height / mapper.info.width)) > minStep) st.points.push([u, v]);
        return;
      }
      const [su, sv] = mapper.toSource(d.start[0], d.start[1]);
      const du = u - su;
      const dv = v - sv;
      if (d.kind === 'lin0') {
        m.linear.x0 = d.mask.linear.x0 + du;
        m.linear.y0 = d.mask.linear.y0 + dv;
      } else if (d.kind === 'lin1') {
        m.linear.x1 = d.mask.linear.x1 + du;
        m.linear.y1 = d.mask.linear.y1 + dv;
      } else if (d.kind === 'linMid') {
        m.linear = { x0: d.mask.linear.x0 + du, y0: d.mask.linear.y0 + dv, x1: d.mask.linear.x1 + du, y1: d.mask.linear.y1 + dv };
      } else if (d.kind === 'radCenter') {
        m.radial.cx = d.mask.radial.cx + du;
        m.radial.cy = d.mask.radial.cy + dv;
      } else if (d.kind === 'radX' || d.kind === 'radY') {
        const dxp = (u - m.radial.cx) * mapper.info.width;
        const dyp = (v - m.radial.cy) * mapper.info.height;
        const r = Math.max(0.005, Math.hypot(dxp, dyp) / long);
        if (d.kind === 'radX') {
          m.radial.rx = r;
          if (e.shiftKey) m.radial.ry = r;
          else m.radial.angle = (Math.atan2(dyp, dxp) * 180) / Math.PI;
        } else {
          m.radial.ry = r;
          if (e.shiftKey) m.radial.rx = r;
        }
      }
    });
  };

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    useDevelop.getState().commit(d.kind === 'brush' ? 'Brush Stroke' : 'Edit Mask');
  };

  const pin = (x: number, y: number, kind: DragKind, color = '#fff', r = 6) => (
    <circle cx={x} cy={y} r={r} fill={color} stroke="#000" strokeWidth={1} style={{ cursor: 'grab' }} onPointerDown={begin(kind)} />
  );

  let shapes: React.ReactNode = null;
  if (active?.kind === 'linear') {
    const { x0, y0, x1, y1 } = active.linear;
    const a = mapper.toScreen(x0, y0);
    const b = mapper.toScreen(x1, y1);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 4000;
    const ny = (dx / len) * 4000;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    shapes = (
      <g>
        <line x1={a[0] - nx} y1={a[1] - ny} x2={a[0] + nx} y2={a[1] + ny} stroke="#fff" strokeWidth={1.5} pointerEvents="stroke" style={{ cursor: 'move' }} onPointerDown={begin('lin0')} />
        <line x1={mid[0] - nx} y1={mid[1] - ny} x2={mid[0] + nx} y2={mid[1] + ny} stroke="rgba(255,255,255,0.5)" strokeWidth={1} pointerEvents="none" />
        <line x1={b[0] - nx} y1={b[1] - ny} x2={b[0] + nx} y2={b[1] + ny} stroke="#fff" strokeDasharray="6 4" strokeWidth={1.5} pointerEvents="stroke" style={{ cursor: 'move' }} onPointerDown={begin('lin1')} />
        {pin(a[0], a[1], 'lin0', '#fff', 5)}
        {pin(b[0], b[1], 'lin1', '#fff', 5)}
        {pin(mid[0], mid[1], 'linMid', '#e0b46a', 7)}
      </g>
    );
  } else if (active?.kind === 'radial') {
    const { cx, cy, rx, ry, angle, feather } = active.radial;
    const ang = (angle * Math.PI) / 180;
    const c = mapper.toScreen(cx, cy);
    const ax = mapper.toScreen(cx + (Math.cos(ang) * rx * long) / mapper.info.width, cy + (Math.sin(ang) * rx * long) / mapper.info.height);
    const by = mapper.toScreen(cx + (-Math.sin(ang) * ry * long) / mapper.info.width, cy + (Math.cos(ang) * ry * long) / mapper.info.height);
    const rX = Math.hypot(ax[0] - c[0], ax[1] - c[1]);
    const rY = Math.hypot(by[0] - c[0], by[1] - c[1]);
    const rot = (Math.atan2(ax[1] - c[1], ax[0] - c[0]) * 180) / Math.PI;
    const inner = Math.max(0, 1 - feather / 100);
    shapes = (
      <g>
        <ellipse cx={c[0]} cy={c[1]} rx={rX} ry={rY} transform={`rotate(${rot} ${c[0]} ${c[1]})`} fill="none" stroke="#fff" strokeWidth={1.5} pointerEvents="none" />
        {inner > 0.02 && (
          <ellipse cx={c[0]} cy={c[1]} rx={rX * inner} ry={rY * inner} transform={`rotate(${rot} ${c[0]} ${c[1]})`} fill="none" stroke="rgba(255,255,255,0.5)" strokeDasharray="4 4" pointerEvents="none" />
        )}
        {pin(ax[0], ax[1], 'radX', '#fff', 5)}
        {pin(2 * c[0] - ax[0], 2 * c[1] - ax[1], 'radX', '#fff', 5)}
        {pin(by[0], by[1], 'radY', '#fff', 5)}
        {pin(2 * c[0] - by[0], 2 * c[1] - by[1], 'radY', '#fff', 5)}
        {pin(c[0], c[1], 'radCenter', '#e0b46a', 7)}
      </g>
    );
  } else if (active?.kind === 'shape' && active.shape.points.length >= 3) {
    const pts = active.shape.points.map(([u, v]) => mapper.toScreen(u, v) as Pt);
    const d = `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`;
    const [cu, cv] = polygonCenter(active.shape.points);
    const c = mapper.toScreen(cu, cv);
    shapes = (
      <g pointerEvents="none">
        <path d={d} fill="none" stroke="#000" strokeWidth={1} />
        <path d={d} fill="none" stroke="#fff" strokeWidth={1} strokeDasharray="4 4" />
        <text x={c[0]} y={c[1] + 4} textAnchor="middle" className="overlay-label">
          Edit with the Select tool (S)
        </text>
      </g>
    );
  }

  // pins for the other masks, to select them
  const others = masks
    .filter((m) => m.id !== activeId)
    .map((m) => {
      let p: [number, number];
      if (m.kind === 'linear') p = mapper.toScreen((m.linear.x0 + m.linear.x1) / 2, (m.linear.y0 + m.linear.y1) / 2);
      else if (m.kind === 'radial') p = mapper.toScreen(m.radial.cx, m.radial.cy);
      else if (m.kind === 'shape') {
        if (!m.shape.points.length) return null;
        const [cu, cv] = polygonCenter(m.shape.points);
        p = mapper.toScreen(cu, cv);
      } else {
        const st = m.brush.strokes[0];
        if (!st) return null;
        p = mapper.toScreen(st.points[0][0], st.points[0][1]);
      }
      return (
        <circle
          key={m.id}
          cx={p[0]}
          cy={p[1]}
          r={5}
          fill="#666"
          stroke="#fff"
          strokeWidth={1}
          style={{ cursor: 'pointer' }}
          onPointerDown={(e) => {
            e.stopPropagation();
            useDevelop.getState().setActiveMask(m.id);
          }}
        >
          <title>{m.name}</title>
        </circle>
      );
    });

  const brushActive = active?.kind === 'brush';
  const brushR = brush.size * long * mapper.pxScale;
  const erasing = brush.erase !== alt;

  return (
    <svg
      ref={svgRef}
      className="overlay"
      width={W}
      height={H}
      style={{ cursor: brushActive ? 'none' : 'default' }}
      onPointerDown={brushActive ? begin('brush') : undefined}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={() => setCursor(null)}
    >
      <rect x={0} y={0} width={W} height={H} fill="transparent" pointerEvents={brushActive ? 'all' : 'none'} />
      {others}
      {shapes}
      {brushActive && cursor && (
        <g pointerEvents="none">
          <circle cx={cursor[0]} cy={cursor[1]} r={brushR} fill="none" stroke="#fff" strokeWidth={1} />
          <circle cx={cursor[0]} cy={cursor[1]} r={brushR * Math.max(0, 1 - brush.feather)} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1} />
          <text x={cursor[0]} y={cursor[1] + 4} textAnchor="middle" className="overlay-label">
            {erasing ? '−' : '+'}
          </text>
        </g>
      )}
    </svg>
  );
}
