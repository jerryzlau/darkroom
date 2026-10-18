import { IDENTITY_CURVE, monotoneSpline, paramsEqual, parametricCurve, type Pt } from '@darkroom/core';
import { useEffect, useRef, useState } from 'react';
import { onReveal } from '../../state/reveal';
import { useDevelop } from '../../state/develop';
import { useHistogram } from '../DevelopCanvas';
import { Section, Seg } from '../ui';
import { PSlider } from './PSlider';

type Ch = 'rgb' | 'r' | 'g' | 'b';
const CH_COLOR: Record<Ch, string> = { rgb: '#ddd', r: '#e25555', g: '#4fc35f', b: '#5b8be8' };
const SIZE = 236;

export function ToneCurvePanel() {
  const tc = useDevelop((s) => s.params.toneCurve);
  const base = useDevelop((s) => s.base.toneCurve);
  const [mode, setMode] = useState<'point' | 'parametric'>('point');
  const [ch, setCh] = useState<Ch>('rgb');
  useEffect(() => onReveal('tonecurve', (c) => c && setMode(c === 'curve' ? 'point' : 'parametric')), []);
  const st = useDevelop.getState;
  return (
    <Section
      id="tonecurve"
      title="Tone Curve"
      changed={!paramsEqual(tc, base)}
      onReset={() => st().resetSection('toneCurve')}
      right={
        <Seg
          small
          value={mode}
          options={[
            { value: 'parametric', label: 'Region' },
            { value: 'point', label: 'Point' },
          ]}
          onChange={setMode}
        />
      }
    >
      {mode === 'point' && (
        <div className="row center">
          <Seg
            small
            value={ch}
            options={(['rgb', 'r', 'g', 'b'] as Ch[]).map((c) => ({ value: c, label: <span style={{ color: CH_COLOR[c] }}>{c.toUpperCase()}</span> }))}
            onChange={setCh}
          />
        </div>
      )}
      <CurveEditor mode={mode} ch={ch} />
      {mode === 'parametric' && (
        <>
          <PSlider label="Highlights" get={(p) => p.toneCurve.region.highlights} set={(p, v) => (p.toneCurve.region.highlights = v)} min={-100} max={100} signedDigits={0} commitLabel="Curve Highlights" />
          <PSlider label="Lights" get={(p) => p.toneCurve.region.lights} set={(p, v) => (p.toneCurve.region.lights = v)} min={-100} max={100} signedDigits={0} commitLabel="Curve Lights" />
          <PSlider label="Darks" get={(p) => p.toneCurve.region.darks} set={(p, v) => (p.toneCurve.region.darks = v)} min={-100} max={100} signedDigits={0} commitLabel="Curve Darks" />
          <PSlider label="Shadows" get={(p) => p.toneCurve.region.shadows} set={(p, v) => (p.toneCurve.region.shadows = v)} min={-100} max={100} signedDigits={0} commitLabel="Curve Shadows" />
          <PSlider label="Split 1" get={(p) => p.toneCurve.splits[0]} set={(p, v) => (p.toneCurve.splits[0] = Math.min(v, p.toneCurve.splits[1] - 5))} min={5} max={45} defaultValue={25} />
          <PSlider label="Split 2" get={(p) => p.toneCurve.splits[1]} set={(p, v) => (p.toneCurve.splits[1] = Math.max(p.toneCurve.splits[0] + 5, Math.min(v, p.toneCurve.splits[2] - 5)))} min={20} max={80} defaultValue={50} />
          <PSlider label="Split 3" get={(p) => p.toneCurve.splits[2]} set={(p, v) => (p.toneCurve.splits[2] = Math.max(v, p.toneCurve.splits[1] + 5))} min={55} max={95} defaultValue={75} />
        </>
      )}
      {mode === 'point' && (
        <div className="hint">Click to add a point, drag to move, double-click a point to remove it.</div>
      )}
    </Section>
  );
}

function CurveEditor({ mode, ch }: { mode: 'point' | 'parametric'; ch: Ch }) {
  const tc = useDevelop((s) => s.params.toneCurve);
  const h = useHistogram((s) => s.h);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const st = useDevelop.getState;
  const pts = tc.points[ch];
  const par = parametricCurve(tc);
  const f = monotoneSpline(pts);
  const S = SIZE;
  const toXY = (x: number, y: number) => [x * S, (1 - y) * S];
  const fromEvent = (e: React.PointerEvent | React.MouseEvent): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };

  // curve path: for point mode show the selected channel's curve, for parametric the region curve
  let d = '';
  for (let i = 0; i <= 128; i++) {
    const x = i / 128;
    const y = mode === 'point' ? f(x) : par(x);
    const [X, Y] = toXY(x, y);
    d += `${i ? 'L' : 'M'}${X.toFixed(1)},${Y.toFixed(1)}`;
  }
  let hist = '';
  if (h) {
    const arr = ch === 'r' ? h.r : ch === 'g' ? h.g : ch === 'b' ? h.b : h.l;
    hist = `M0,${S}`;
    for (let i = 0; i < 256; i++) hist += `L${((i / 255) * S).toFixed(1)},${(S - Math.sqrt(Math.min(1, arr[i] / h.max)) * S * 0.9).toFixed(1)}`;
    hist += `L${S},${S}Z`;
  }

  const setPts = (next: Pt[]) =>
    st().update((p) => {
      p.toneCurve.points[ch] = next;
    });

  const onDown = (e: React.PointerEvent) => {
    if (mode !== 'point' || e.button !== 0) return;
    const [x, y] = fromEvent(e);
    // grab the nearest point if close, else add one on the curve
    let idx = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.04);
    if (idx < 0) {
      const next = [...pts, [x, f(x)] as Pt].sort((a, b) => a[0] - b[0]);
      idx = next.findIndex((p) => p[0] === x);
      setPts(next);
    }
    drag.current = idx;
    svg.current!.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const i = drag.current;
    if (i === null) return;
    const [x, y] = fromEvent(e);
    const cur = st().params.toneCurve.points[ch];
    const next = cur.map((p) => [...p] as Pt);
    const lo = i === 0 ? 0 : next[i - 1][0] + 0.01;
    const hi = i === next.length - 1 ? 1 : next[i + 1][0] - 0.01;
    next[i] = [Math.min(hi, Math.max(lo, x)), y];
    setPts(next);
  };

  const onUp = () => {
    if (drag.current === null) return;
    drag.current = null;
    st().commit('Point Curve');
  };

  const onDouble = (e: React.MouseEvent) => {
    if (mode !== 'point') return;
    const [x, y] = fromEvent(e);
    const idx = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.05);
    if (idx > 0 && idx < pts.length - 1) {
      setPts(pts.filter((_, i) => i !== idx));
      st().commit('Point Curve');
    } else if (idx === -1 && pts.length <= 2) {
      setPts(IDENTITY_CURVE.map((p) => [...p] as Pt));
      st().commit('Point Curve');
    }
  };

  return (
    <div className="curve-editor" data-ctl="curve">
      <svg ref={svg} viewBox={`0 0 ${S} ${S}`} width="100%" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDouble}>
        <rect x={0} y={0} width={S} height={S} fill="#1a1a1c" />
        {hist && <path d={hist} fill="rgba(255,255,255,0.08)" />}
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="rgba(255,255,255,0.08)">
            <line x1={g * S} y1={0} x2={g * S} y2={S} />
            <line x1={0} y1={g * S} x2={S} y2={g * S} />
          </g>
        ))}
        {mode === 'parametric' &&
          tc.splits.map((s, i) => <line key={i} x1={(s / 100) * S} y1={0} x2={(s / 100) * S} y2={S} stroke="rgba(224,180,106,0.35)" strokeDasharray="3 3" />)}
        <line x1={0} y1={S} x2={S} y2={0} stroke="rgba(255,255,255,0.15)" />
        <path d={d} fill="none" stroke={mode === 'point' ? CH_COLOR[ch] : '#ddd'} strokeWidth={1.6} />
        {mode === 'point' &&
          pts.map(([x, y], i) => {
            const [X, Y] = toXY(x, y);
            return <circle key={i} cx={X} cy={Y} r={4} fill="#1a1a1c" stroke={CH_COLOR[ch]} strokeWidth={1.5} />;
          })}
      </svg>
    </div>
  );
}
