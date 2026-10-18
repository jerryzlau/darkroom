import { paramsEqual } from '@darkroom/core';
import { useDevelop } from '../../state/develop';
import { Section } from '../ui';
import { PSlider } from './PSlider';

export function DetailPanel() {
  const d = useDevelop((s) => s.params.detail);
  const base = useDevelop((s) => s.base.detail);
  return (
    <Section id="detail" title="Detail" changed={!paramsEqual(d, base)} onReset={() => useDevelop.getState().resetSection('detail')}>
      <div className="subhead">
        <span>Sharpening</span>
      </div>
      <PSlider id="sharpen-amount" label="Amount" get={(p) => p.detail.sharpAmount} set={(p, v) => (p.detail.sharpAmount = v)} min={0} max={150} defaultValue={base.sharpAmount} commitLabel="Sharpening" />
      <PSlider id="sharpen-radius" label="Radius" get={(p) => p.detail.sharpRadius} set={(p, v) => (p.detail.sharpRadius = v)} min={0.5} max={3} step={0.1} defaultValue={1} commitLabel="Sharpen Radius" />
      <PSlider id="sharpen-detail" label="Detail" get={(p) => p.detail.sharpDetail} set={(p, v) => (p.detail.sharpDetail = v)} min={0} max={100} defaultValue={25} commitLabel="Sharpen Detail" />
      <PSlider id="sharpen-masking" label="Masking" get={(p) => p.detail.sharpMasking} set={(p, v) => (p.detail.sharpMasking = v)} min={0} max={100} defaultValue={0} commitLabel="Sharpen Masking" />
      <div className="subhead">
        <span>Noise Reduction</span>
      </div>
      <PSlider id="nr-luminance" label="Luminance" get={(p) => p.detail.nrLuma} set={(p, v) => (p.detail.nrLuma = v)} min={0} max={100} defaultValue={0} commitLabel="Luminance NR" />
      <PSlider id="nr-luminance-detail" label="Detail" get={(p) => p.detail.nrLumaDetail} set={(p, v) => (p.detail.nrLumaDetail = v)} min={0} max={100} defaultValue={50} commitLabel="Luminance NR Detail" disabled={d.nrLuma === 0} />
      <PSlider id="nr-color" label="Color" get={(p) => p.detail.nrColor} set={(p, v) => (p.detail.nrColor = v)} min={0} max={100} defaultValue={base.nrColor} commitLabel="Color NR" />
      <PSlider id="nr-color-detail" label="Detail" get={(p) => p.detail.nrColorDetail} set={(p, v) => (p.detail.nrColorDetail = v)} min={0} max={100} defaultValue={50} commitLabel="Color NR Detail" disabled={d.nrColor === 0} />
      <div className="hint">Zoom to 100% to judge sharpening and noise reduction.</div>
    </Section>
  );
}

export function LensPanel() {
  const l = useDevelop((s) => s.params.lens);
  const base = useDevelop((s) => s.base.lens);
  return (
    <Section id="lens" title="Lens Corrections" changed={!paramsEqual(l, base)} onReset={() => useDevelop.getState().resetSection('lens')} defaultOpen={false}>
      <PSlider label="Distortion" get={(p) => p.lens.distortion} set={(p, v) => (p.lens.distortion = v)} min={-100} max={100} signedDigits={0} title="Positive values correct barrel distortion" />
      <PSlider label="Vignetting" get={(p) => p.lens.vignette} set={(p, v) => (p.lens.vignette = v)} min={-100} max={100} signedDigits={0} commitLabel="Lens Vignetting" title="Positive values brighten the corners" />
      <PSlider label="Red / Cyan fringe" get={(p) => p.lens.caRed} set={(p, v) => (p.lens.caRed = v)} min={-100} max={100} signedDigits={0} commitLabel="Chromatic Aberration" />
      <PSlider label="Blue / Yellow fringe" get={(p) => p.lens.caBlue} set={(p, v) => (p.lens.caBlue = v)} min={-100} max={100} signedDigits={0} commitLabel="Chromatic Aberration" />
    </Section>
  );
}

export function EffectsPanel() {
  const e = useDevelop((s) => s.params.effects);
  const base = useDevelop((s) => s.base.effects);
  return (
    <Section id="effects" title="Effects" changed={!paramsEqual(e, base)} onReset={() => useDevelop.getState().resetSection('effects')} defaultOpen={false}>
      <div className="subhead">
        <span>Post-Crop Vignetting</span>
      </div>
      <PSlider id="vignette-amount" label="Amount" get={(p) => p.effects.vignetteAmount} set={(p, v) => (p.effects.vignetteAmount = v)} min={-100} max={100} signedDigits={0} commitLabel="Vignette" />
      <PSlider id="vignette-midpoint" label="Midpoint" get={(p) => p.effects.vignetteMidpoint} set={(p, v) => (p.effects.vignetteMidpoint = v)} min={0} max={100} defaultValue={50} commitLabel="Vignette Midpoint" disabled={e.vignetteAmount === 0} />
      <PSlider id="vignette-roundness" label="Roundness" get={(p) => p.effects.vignetteRoundness} set={(p, v) => (p.effects.vignetteRoundness = v)} min={-100} max={100} signedDigits={0} commitLabel="Vignette Roundness" disabled={e.vignetteAmount === 0} />
      <PSlider id="vignette-feather" label="Feather" get={(p) => p.effects.vignetteFeather} set={(p, v) => (p.effects.vignetteFeather = v)} min={0} max={100} defaultValue={50} commitLabel="Vignette Feather" disabled={e.vignetteAmount === 0} />
      <div className="subhead">
        <span>Grain</span>
      </div>
      <PSlider id="grain-amount" label="Amount" get={(p) => p.effects.grainAmount} set={(p, v) => (p.effects.grainAmount = v)} min={0} max={100} defaultValue={0} commitLabel="Grain" />
      <PSlider id="grain-size" label="Size" get={(p) => p.effects.grainSize} set={(p, v) => (p.effects.grainSize = v)} min={0} max={100} defaultValue={25} commitLabel="Grain Size" disabled={e.grainAmount === 0} />
      <PSlider id="grain-roughness" label="Roughness" get={(p) => p.effects.grainRoughness} set={(p, v) => (p.effects.grainRoughness = v)} min={0} max={100} defaultValue={50} commitLabel="Grain Roughness" disabled={e.grainAmount === 0} />
    </Section>
  );
}
