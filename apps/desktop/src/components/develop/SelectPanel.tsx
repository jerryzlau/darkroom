import { useEffect } from 'react';
import { useDevelop, type SelectMode } from '../../state/develop';
import { useUi } from '../../state/ui';
import { Section, Seg, Slider } from '../ui';

/** Feather slider runs 0..100 for 0..0.2 of the long edge. */
const FEATHER_SCALE = 500;

export function SelectPanel() {
  const masks = useDevelop((s) => s.params.masks);
  const activeId = useDevelop((s) => s.activeMaskId);
  const settings = useDevelop((s) => s.select);
  const view = useDevelop((s) => s.view);
  const st = useDevelop.getState;
  const idx = masks.findIndex((m) => m.id === activeId);
  const active = idx >= 0 ? masks[idx] : null;
  const shape = active?.kind === 'shape' ? active : null;

  // keep the overlay pointing at the active mask
  useEffect(() => {
    if (view.overlayMask >= 0 && idx >= 0 && view.overlayMask !== idx) st().setView({ overlayMask: idx, overlayInvert: masks[idx].invert });
  }, [idx, view.overlayMask, masks, st]);

  // edits apply to the selected shape and become the default for new ones
  const changeFeather = (feather: number, commit: boolean) => {
    st().setSelect({ feather });
    if (shape) {
      st().update((p) => {
        const m = p.masks.find((x) => x.id === shape.id);
        if (m) m.shape.feather = feather;
      });
      if (commit) st().commit('Selection Feather');
    }
  };
  const feather = shape ? shape.shape.feather : settings.feather;

  const clear = () => {
    if (!shape) return;
    const id = shape.id;
    st().setAndCommit((p) => (p.masks = p.masks.filter((m) => m.id !== id)), 'Delete Mask');
    st().setActiveMask(null);
    st().setView({ overlayMask: -1 });
  };

  return (
    <Section id="select" title="Selection">
      <div className="row">
        <span className="row-label">Shape</span>
        <Seg<SelectMode>
          small
          value={settings.mode}
          options={[
            { value: 'lasso', label: 'Lasso' },
            { value: 'rect', label: 'Rectangle' },
            { value: 'ellipse', label: 'Ellipse' },
          ]}
          onChange={(v) => st().setSelect({ mode: v })}
        />
      </div>
      <Slider
        label="Feather"
        value={Math.round(Math.min(100, feather * FEATHER_SCALE) * 10) / 10}
        min={0}
        max={100}
        step={0.5}
        defaultValue={10}
        onChange={(v) => changeFeather(v / FEATHER_SCALE, false)}
        onCommit={() => shape && st().commit('Selection Feather')}
      />
      {active && (
        <div className="hint">
          Active: {active.name}
        </div>
      )}
      <div className="btn-row">
        <button disabled={!shape} onClick={clear}>
          Clear selection
        </button>
        <button
          disabled={idx < 0}
          className={idx >= 0 && view.overlayMask === idx ? 'active' : ''}
          onClick={() => active && st().setView({ overlayMask: view.overlayMask === idx ? -1 : idx, overlayInvert: active.invert })}
        >
          Show overlay
        </button>
        <button onClick={() => useUi.getState().toggleAi(true)}>Ask AI…</button>
      </div>
      <div className="hint">
        Drag on the photo to select an area (hold ⇧ for a square or circle). Click a selection to make it active, or click outside to deselect. Adjust it in Masks (M) or ask the AI to change just that area. ⌫ deletes the active selection.
      </div>
    </Section>
  );
}
