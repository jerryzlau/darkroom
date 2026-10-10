import { useDevelop } from '../../state/develop';
import { Section, Seg, Slider } from '../ui';

export function SpotsPanel() {
  const spots = useDevelop((s) => s.params.spots);
  const activeId = useDevelop((s) => s.activeSpotId);
  const settings = useDevelop((s) => s.spot);
  const st = useDevelop.getState;
  const active = spots.find((s) => s.id === activeId) ?? null;
  // edits apply to the selected spot and become the default for new ones
  const change = (patch: Partial<typeof settings>, commit: boolean) => {
    st().setSpot(patch);
    if (active) {
      st().update((p) => {
        const s = p.spots.find((x) => x.id === active.id);
        if (s) Object.assign(s, patch);
      });
      if (commit) st().commit('Edit Spot');
    }
  };
  const cur = active ? { mode: active.mode, r: active.r, feather: active.feather, opacity: active.opacity } : settings;
  return (
    <Section id="spots" title="Spot Removal">
      <div className="row">
        <span className="row-label">Mode</span>
        <Seg
          small
          value={cur.mode}
          options={[
            { value: 'heal', label: 'Heal' },
            { value: 'clone', label: 'Clone' },
          ]}
          onChange={(v) => change({ mode: v }, true)}
        />
      </div>
      <Slider label="Size" value={Math.round(cur.r * 1000) / 10} min={0.1} max={15} step={0.1} defaultValue={1.2} format={(v) => `${v.toFixed(1)}%`} onChange={(v) => change({ r: v / 100 }, false)} onCommit={() => active && st().commit('Spot Size')} />
      <Slider label="Feather" value={Math.round(cur.feather * 100)} min={0} max={100} defaultValue={50} onChange={(v) => change({ feather: v / 100 }, false)} onCommit={() => active && st().commit('Spot Feather')} />
      <Slider label="Opacity" value={Math.round(cur.opacity * 100)} min={1} max={100} defaultValue={100} onChange={(v) => change({ opacity: v / 100 }, false)} onCommit={() => active && st().commit('Spot Opacity')} />
      <div className="btn-row">
        <button
          disabled={!active}
          onClick={() => {
            st().setAndCommit((p) => (p.spots = p.spots.filter((s) => s.id !== activeId)), 'Delete Spot');
            st().setActiveSpot(null);
          }}
        >
          Delete spot
        </button>
        <button disabled={!spots.length} onClick={() => st().setAndCommit((p) => (p.spots = []), 'Clear Spots')}>
          Clear all ({spots.length})
        </button>
      </div>
      <div className="hint">Click a blemish to remove it. Drag the solid circle to move the spot and the dashed circle to pick a different source. [ and ] change the size, ⌫ deletes the selected spot.</div>
    </Section>
  );
}
