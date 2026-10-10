import { paramsEqual, type WheelHSL } from '@darkroom/core';
import { useRef } from 'react';
import { useDevelop } from '../../state/develop';
import { Section } from '../ui';
import { PSlider } from './PSlider';

type Region = 'shadows' | 'midtones' | 'highlights' | 'global';

function Wheel({ region, label, size }: { region: Region; label: string; size: number }) {
  const w = useDevelop((s) => s.params.grading[region]);
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const st = useDevelop.getState;
  const set = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    let s = Math.min(1, Math.hypot(x, y) / 0.5);
    if (e.shiftKey) s = st().params.grading[region].s / 100; // shift: change hue only
    let h = ((Math.atan2(-y, x) * 180) / Math.PI + 360) % 360;
    st().update((p) => {
      p.grading[region] = { ...p.grading[region], h: Math.round(h), s: Math.round(s * 100) };
    });
  };
  const ang = (w.h * Math.PI) / 180;
  const px = 50 + Math.cos(ang) * (w.s / 100) * 50;
  const py = 50 - Math.sin(ang) * (w.s / 100) * 50;
  return (
    <div className="wheel-wrap">
      <div className="wheel-label">{label}</div>
      <div
        className="wheel"
        ref={ref}
        style={{ width: size, height: size }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          dragging.current = true;
          set(e);
        }}
        onPointerMove={(e) => dragging.current && set(e)}
        onPointerUp={() => {
          dragging.current = false;
          st().commit(`Grading ${label}`);
        }}
        onDoubleClick={() => st().setAndCommit((p) => (p.grading[region] = { h: 0, s: 0, l: p.grading[region].l }), `Reset ${label}`)}
        title="Drag to set hue and saturation; double-click to reset; hold Shift to change only the hue"
      >
        <div className="wheel-dot" style={{ left: `${px}%`, top: `${py}%` }} />
      </div>
      <div className="wheel-values">
        H {w.h}° · S {w.s}
      </div>
      <PSlider
        label="Luminance"
        get={(p) => (p.grading[region] as WheelHSL).l}
        set={(p, v) => (p.grading[region] = { ...p.grading[region], l: v })}
        min={-100}
        max={100}
        signedDigits={0}
        commitLabel={`${label} Luminance`}
      />
    </div>
  );
}

export function ColorGradingPanel() {
  const g = useDevelop((s) => s.params.grading);
  const base = useDevelop((s) => s.base.grading);
  return (
    <Section id="grading" title="Color Grading" changed={!paramsEqual(g, base)} onReset={() => useDevelop.getState().resetSection('colorGrading')}>
      <div className="wheels-top">
        <Wheel region="midtones" label="Midtones" size={118} />
      </div>
      <div className="wheels-row">
        <Wheel region="shadows" label="Shadows" size={96} />
        <Wheel region="highlights" label="Highlights" size={96} />
      </div>
      <div className="wheels-top">
        <Wheel region="global" label="Global" size={84} />
      </div>
      <PSlider label="Blending" get={(p) => p.grading.blending} set={(p, v) => (p.grading.blending = v)} min={0} max={100} defaultValue={50} />
      <PSlider label="Balance" get={(p) => p.grading.balance} set={(p, v) => (p.grading.balance = v)} min={-100} max={100} signedDigits={0} />
    </Section>
  );
}
