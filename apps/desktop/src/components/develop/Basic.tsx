import { asShotTempTint, paramsEqual, pickSections, sliderFromTemp, tempFromSlider } from '@darkroom/core';
import { autoTone, autoWhiteBalance } from '../../lib/auto';
import { useDevelop } from '../../state/develop';
import { Section, Seg } from '../ui';
import { fmtSigned, PSlider } from './PSlider';

const TEMP_TRACK = 'linear-gradient(90deg, #3b6fd8, #d8d8d8 45%, #e6c04a)';
const TINT_TRACK = 'linear-gradient(90deg, #3fae4a, #d8d8d8 50%, #c04ac9)';

export function BasicPanel() {
  const p = useDevelop((s) => s.params);
  const base = useDevelop((s) => s.base);
  const source = useDevelop((s) => s.source);
  const tool = useDevelop((s) => s.tool);
  const st = useDevelop.getState;
  const changed = !paramsEqual(pickSections(p, ['whiteBalance', 'basicTone', 'presence', 'treatment']), pickSections(base, ['whiteBalance', 'basicTone', 'presence', 'treatment']));

  const wbMode = p.wb.mode === 'asShot' ? 'asShot' : 'custom';
  const setWbPreset = (v: string) => {
    if (!source) return;
    if (v === 'asShot') {
      const t = asShotTempTint(source.color);
      st().setAndCommit((q) => (q.wb = { mode: 'asShot', temp: t.temp, tint: t.tint }), 'WB: As Shot');
    } else if (v === 'auto') {
      const t = autoWhiteBalance(source);
      st().setAndCommit((q) => (q.wb = { mode: 'custom', ...t }), 'WB: Auto');
    } else {
      const presets: Record<string, [number, number]> = {
        daylight: [5500, 10],
        cloudy: [6500, 10],
        shade: [7500, 10],
        tungsten: [2850, 0],
        fluorescent: [3800, 21],
        flash: [5500, 0],
      };
      const [temp, tint] = presets[v] ?? [p.wb.temp, p.wb.tint];
      st().setAndCommit((q) => (q.wb = { mode: 'custom', temp, tint }), `WB: ${v}`);
    }
  };

  return (
    <Section
      id="basic"
      title="Basic"
      changed={changed}
      onReset={() => {
        st().replace({ ...st().params, ...pickSections(st().base, ['whiteBalance', 'basicTone', 'presence', 'treatment']) });
        st().commit('Reset Basic');
      }}
    >
      <div className="row" data-ctl="treatment">
        <span className="row-label">Treatment</span>
        <Seg
          small
          value={p.treatment}
          options={[
            { value: 'color', label: 'Color' },
            { value: 'bw', label: 'B&W' },
          ]}
          onChange={(v) => st().setAndCommit((q) => (q.treatment = v), v === 'bw' ? 'Black & White' : 'Color')}
        />
      </div>
      <div className="row" data-ctl="wb">
        <span className="row-label">WB</span>
        <select value={wbMode} onChange={(e) => setWbPreset(e.target.value)}>
          <option value="asShot">As Shot</option>
          <option value="custom">Custom</option>
          <option value="auto">Auto</option>
          {source?.color.isRaw && (
            <>
              <option value="daylight">Daylight</option>
              <option value="cloudy">Cloudy</option>
              <option value="shade">Shade</option>
              <option value="tungsten">Tungsten</option>
              <option value="fluorescent">Fluorescent</option>
              <option value="flash">Flash</option>
            </>
          )}
        </select>
        <button className={`icon-btn ${tool === 'wb' ? 'active' : ''}`} title="White balance selector (W): click a neutral area" onClick={() => st().setTool('wb')}>
          ⌖
        </button>
      </div>
      <PSlider
        label="Temp"
        get={(q) => q.wb.temp}
        set={(q, v) => (q.wb = { ...q.wb, mode: 'custom', temp: v })}
        min={2000}
        max={50000}
        step={10}
        defaultValue={base.wb.temp}
        toPos={sliderFromTemp}
        fromPos={(t) => Math.round(tempFromSlider(t) / 10) * 10}
        format={(v) => `${Math.round(v)} K`}
        track={TEMP_TRACK}
        commitLabel="Temperature"
      />
      <PSlider label="Tint" get={(q) => q.wb.tint} set={(q, v) => (q.wb = { ...q.wb, mode: 'custom', tint: v })} min={-150} max={150} defaultValue={base.wb.tint} track={TINT_TRACK} signedDigits={0} />
      <div className="subhead">
        <span>Tone</span>
        <button
          className="link-btn"
          title="Auto tone"
          onClick={() => {
            if (!source) return;
            const a = autoTone(source, st().params);
            st().setAndCommit((q) => Object.assign(q, a), 'Auto Tone');
          }}
        >
          Auto
        </button>
      </div>
      <PSlider label="Exposure" get={(q) => q.exposure} set={(q, v) => (q.exposure = v)} min={-5} max={5} step={0.01} signedDigits={2} />
      <PSlider label="Contrast" get={(q) => q.contrast} set={(q, v) => (q.contrast = v)} min={-100} max={100} signedDigits={0} />
      <PSlider label="Highlights" get={(q) => q.highlights} set={(q, v) => (q.highlights = v)} min={-100} max={100} signedDigits={0} />
      <PSlider label="Shadows" get={(q) => q.shadows} set={(q, v) => (q.shadows = v)} min={-100} max={100} signedDigits={0} />
      <PSlider label="Whites" get={(q) => q.whites} set={(q, v) => (q.whites = v)} min={-100} max={100} signedDigits={0} />
      <PSlider label="Blacks" get={(q) => q.blacks} set={(q, v) => (q.blacks = v)} min={-100} max={100} signedDigits={0} />
      <div className="subhead">
        <span>Presence</span>
      </div>
      <PSlider label="Texture" get={(q) => q.texture} set={(q, v) => (q.texture = v)} min={-100} max={100} signedDigits={0} />
      <PSlider label="Clarity" get={(q) => q.clarity} set={(q, v) => (q.clarity = v)} min={-100} max={100} signedDigits={0} />
      <PSlider label="Dehaze" get={(q) => q.dehaze} set={(q, v) => (q.dehaze = v)} min={-100} max={100} signedDigits={0} />
      <PSlider label="Vibrance" get={(q) => q.vibrance} set={(q, v) => (q.vibrance = v)} min={-100} max={100} signedDigits={0} />
      <PSlider label="Saturation" get={(q) => q.saturation} set={(q, v) => (q.saturation = v)} min={-100} max={100} signedDigits={0} format={fmtSigned(0)} />
    </Section>
  );
}
