import { newMask, type Mask, type MaskKind } from '@darkroom/core';
import { useEffect } from 'react';
import { MAX_MASKS } from '../../engine/shaders';
import { useDevelop } from '../../state/develop';
import { toast } from '../../state/toast';
import { Section, Seg, Slider } from '../ui';
import { PSlider } from './PSlider';

const LOCAL: { key: keyof Mask['adj']; label: string; min: number; max: number; step?: number }[] = [
  { key: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.01 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'whites', label: 'Whites', min: -100, max: 100 },
  { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
  { key: 'temp', label: 'Temp', min: -100, max: 100 },
  { key: 'tint', label: 'Tint', min: -100, max: 100 },
  { key: 'texture', label: 'Texture', min: -100, max: 100 },
  { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
  { key: 'dehaze', label: 'Dehaze', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
];

export function MasksPanel() {
  const masks = useDevelop((s) => s.params.masks);
  const activeId = useDevelop((s) => s.activeMaskId);
  const view = useDevelop((s) => s.view);
  const brush = useDevelop((s) => s.brush);
  const st = useDevelop.getState;
  const idx = masks.findIndex((m) => m.id === activeId);
  const active = idx >= 0 ? masks[idx] : null;

  // keep the overlay pointing at the active mask
  useEffect(() => {
    if (view.overlayMask >= 0 && idx >= 0 && view.overlayMask !== idx) st().setView({ overlayMask: idx, overlayInvert: masks[idx].invert });
  }, [idx, view.overlayMask, masks, st]);

  const add = (kind: MaskKind) => {
    if (masks.length >= MAX_MASKS) return toast(`Up to ${MAX_MASKS} masks per photo`, 'warn');
    const m = newMask(kind, masks.length);
    st().setAndCommit((p) => p.masks.push(m), `New ${m.name}`);
    st().setActiveMask(m.id);
  };

  const patch = (fn: (m: Mask) => void, label: string) =>
    st().setAndCommit((p) => {
      const m = p.masks[idx];
      if (m) fn(m);
    }, label);

  return (
    <Section id="masks" title="Masks">
      <div className="btn-row" data-ctl="add-mask">
        <button onClick={() => add('linear')} title="Linear gradient">
          ▤ Linear
        </button>
        <button onClick={() => add('radial')} title="Radial gradient">
          ◎ Radial
        </button>
        <button onClick={() => add('brush')} title="Brush (K)">
          ✎ Brush
        </button>
        <button onClick={() => st().setTool('select')} title="Selection: lasso, rectangle or ellipse (S)">
          ◇ Select
        </button>
      </div>
      {masks.length === 0 && <div className="hint">Add a mask to make local adjustments.</div>}
      <ul className="mask-list">
        {masks.map((m, i) => (
          <li key={m.id} className={m.id === activeId ? 'active' : ''} onClick={() => st().setActiveMask(m.id)}>
            <input
              type="checkbox"
              checked={m.enabled}
              title="Enable"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => st().setAndCommit((p) => (p.masks[i].enabled = e.target.checked), 'Toggle Mask')}
            />
            <span className="mask-name">
              {m.kind === 'shape' ? '◇ ' : ''}
              {m.name}
            </span>
            <button
              className={`icon-btn small ${view.overlayMask === i ? 'active' : ''}`}
              title="Show overlay (O)"
              onClick={(e) => {
                e.stopPropagation();
                st().setActiveMask(m.id);
                st().setView({ overlayMask: view.overlayMask === i ? -1 : i, overlayInvert: m.invert });
              }}
            >
              ◐
            </button>
            <button
              className="icon-btn small"
              title="Delete mask"
              onClick={(e) => {
                e.stopPropagation();
                st().setAndCommit((p) => p.masks.splice(i, 1), 'Delete Mask');
                if (m.id === activeId) st().setActiveMask(null);
                st().setView({ overlayMask: -1 });
              }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {active && (
        <div className="mask-editor">
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={active.invert} onChange={(e) => patch((m) => (m.invert = e.target.checked), 'Invert Mask')} /> Invert
            </label>
            <input
              className="mask-rename"
              value={active.name}
              onChange={(e) => st().update((p) => (p.masks[idx].name = e.target.value))}
              onBlur={() => st().commit('Rename Mask')}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <PSlider label="Amount" get={(p) => p.masks[idx]?.amount ?? 100} set={(p, v) => (p.masks[idx].amount = v)} min={0} max={100} defaultValue={100} commitLabel="Mask Amount" />
          {active.kind === 'radial' && (
            <>
              <PSlider label="Feather" get={(p) => p.masks[idx]?.radial.feather ?? 50} set={(p, v) => (p.masks[idx].radial.feather = v)} min={0} max={100} defaultValue={50} commitLabel="Mask Feather" />
              <PSlider label="Angle" get={(p) => p.masks[idx]?.radial.angle ?? 0} set={(p, v) => (p.masks[idx].radial.angle = v)} min={-180} max={180} defaultValue={0} commitLabel="Mask Angle" />
            </>
          )}
          {active.kind === 'shape' && (
            <>
              <PSlider
                label="Feather"
                get={(p) => Math.min(100, (p.masks[idx]?.shape.feather ?? 0.02) * 500)}
                set={(p, v) => (p.masks[idx].shape.feather = v / 500)}
                min={0}
                max={100}
                step={0.5}
                defaultValue={10}
                commitLabel="Selection Feather"
              />
              <button className="link-btn" onClick={() => st().setTool('select')}>
                Redraw with Select tool
              </button>
            </>
          )}
          {active.kind === 'brush' && (
            <div className="brush-settings">
              <div className="row">
                <span className="row-label">Brush</span>
                <Seg
                  small
                  value={brush.erase ? 'erase' : 'paint'}
                  options={[
                    { value: 'paint', label: 'Paint' },
                    { value: 'erase', label: 'Erase' },
                  ]}
                  onChange={(v) => st().setBrush({ erase: v === 'erase' })}
                />
              </div>
              <Slider label="Size" value={Math.round(brush.size * 1000) / 10} min={0.2} max={30} step={0.1} defaultValue={4} onChange={(v) => st().setBrush({ size: v / 100 })} format={(v) => `${v.toFixed(1)}%`} />
              <Slider label="Feather" value={Math.round(brush.feather * 100)} min={0} max={100} defaultValue={60} onChange={(v) => st().setBrush({ feather: v / 100 })} />
              <Slider label="Flow" value={Math.round(brush.flow * 100)} min={1} max={100} defaultValue={100} onChange={(v) => st().setBrush({ flow: v / 100 })} />
              <div className="hint">Paint on the photo. Hold ⌥ to erase, [ and ] change the size.</div>
              {active.brush.strokes.length > 0 && (
                <button className="link-btn" onClick={() => patch((m) => (m.brush.strokes = []), 'Clear Brush')}>
                  Clear strokes
                </button>
              )}
            </div>
          )}
          <div className="subhead" data-ctl="range">
            <span>Range</span>
            <Seg
              small
              value={active.range.mode}
              options={[
                { value: 'none', label: 'Off' },
                { value: 'luminance', label: 'Lum' },
                { value: 'color', label: 'Color' },
              ]}
              onChange={(v) => patch((m) => (m.range.mode = v), 'Range Mask')}
            />
          </div>
          {active.range.mode === 'luminance' && (
            <>
              <PSlider label="From" get={(p) => p.masks[idx]?.range.lumMin ?? 0} set={(p, v) => (p.masks[idx].range.lumMin = Math.min(v, p.masks[idx].range.lumMax))} min={0} max={100} defaultValue={0} commitLabel="Range" />
              <PSlider label="To" get={(p) => p.masks[idx]?.range.lumMax ?? 100} set={(p, v) => (p.masks[idx].range.lumMax = Math.max(v, p.masks[idx].range.lumMin))} min={0} max={100} defaultValue={100} commitLabel="Range" />
              <PSlider label="Smoothness" get={(p) => p.masks[idx]?.range.lumFeather ?? 20} set={(p, v) => (p.masks[idx].range.lumFeather = v)} min={0} max={100} defaultValue={20} commitLabel="Range" />
            </>
          )}
          {active.range.mode === 'color' && (
            <>
              <PSlider label="Hue" get={(p) => p.masks[idx]?.range.hue ?? 0} set={(p, v) => (p.masks[idx].range.hue = v)} min={0} max={360} defaultValue={0} track="linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" commitLabel="Range" />
              <PSlider label="Saturation" get={(p) => Math.round((p.masks[idx]?.range.sat ?? 0.5) * 100)} set={(p, v) => (p.masks[idx].range.sat = v / 100)} min={0} max={100} defaultValue={50} commitLabel="Range" />
              <PSlider label="Tolerance" get={(p) => p.masks[idx]?.range.amount ?? 50} set={(p, v) => (p.masks[idx].range.amount = v)} min={0} max={100} defaultValue={50} commitLabel="Range" />
            </>
          )}
          <div className="subhead" data-ctl="adjustments">
            <span>Adjustments</span>
            <button className="link-btn" onClick={() => patch((m) => Object.keys(m.adj).forEach((k) => ((m.adj as unknown as Record<string, number>)[k] = 0)), 'Reset Mask Adjustments')}>
              Reset
            </button>
          </div>
          {LOCAL.map((s) => (
            <PSlider
              key={s.key}
              label={s.label}
              get={(p) => p.masks[idx]?.adj[s.key] ?? 0}
              set={(p, v) => (p.masks[idx].adj[s.key] = v)}
              min={s.min}
              max={s.max}
              step={s.step}
              signedDigits={s.step ? 2 : 0}
              commitLabel={`Mask ${s.label}`}
            />
          ))}
        </div>
      )}
    </Section>
  );
}
