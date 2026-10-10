import { HSL_BANDS, HSL_BAND_CENTERS, paramsEqual } from '@darkroom/core';
import { useState } from 'react';
import { useDevelop } from '../../state/develop';
import { Section, Seg } from '../ui';
import { PSlider } from './PSlider';

const hsl = (h: number, s = 80, l = 50) => `hsl(${h} ${s}% ${l}%)`;
const name = (b: string) => b[0].toUpperCase() + b.slice(1);

export function ColorMixerPanel() {
  const p = useDevelop((s) => s.params);
  const base = useDevelop((s) => s.base);
  const [tab, setTab] = useState<'hue' | 'sat' | 'lum'>('hue');
  const st = useDevelop.getState;
  const bw = p.treatment === 'bw';
  if (bw) {
    return (
      <Section id="bwmix" title="B&W Mix" changed={!paramsEqual(p.bwMix, base.bwMix)} onReset={() => st().setAndCommit((q) => (q.bwMix = [0, 0, 0, 0, 0, 0, 0, 0]), 'Reset B&W Mix')}>
        {HSL_BANDS.map((b, i) => (
          <PSlider
            key={b}
            label={name(b)}
            get={(q) => q.bwMix[i]}
            set={(q, v) => (q.bwMix[i] = v)}
            min={-100}
            max={100}
            signedDigits={0}
            track={`linear-gradient(90deg, #111, ${hsl(HSL_BAND_CENTERS[i], 25, 50)}, #eee)`}
            commitLabel={`B&W ${name(b)}`}
          />
        ))}
      </Section>
    );
  }
  return (
    <Section
      id="colormixer"
      title="Color Mixer"
      changed={!paramsEqual(p.hsl, base.hsl)}
      onReset={() => st().resetSection('colorMixer')}
      right={
        <Seg
          small
          value={tab}
          options={[
            { value: 'hue', label: 'Hue' },
            { value: 'sat', label: 'Sat' },
            { value: 'lum', label: 'Lum' },
          ]}
          onChange={setTab}
        />
      }
    >
      {HSL_BANDS.map((b, i) => {
        const c = HSL_BAND_CENTERS[i];
        const track =
          tab === 'hue'
            ? `linear-gradient(90deg, ${hsl(c - 30)}, ${hsl(c)}, ${hsl(c + 30)})`
            : tab === 'sat'
              ? `linear-gradient(90deg, ${hsl(c, 0)}, ${hsl(c, 90)})`
              : `linear-gradient(90deg, ${hsl(c, 70, 15)}, ${hsl(c, 70, 50)}, ${hsl(c, 70, 85)})`;
        return (
          <PSlider
            key={`${tab}-${b}`}
            label={name(b)}
            get={(q) => q.hsl[tab][i]}
            set={(q, v) => (q.hsl[tab][i] = v)}
            min={-100}
            max={100}
            signedDigits={0}
            track={track}
            commitLabel={`${name(b)} ${tab === 'hue' ? 'Hue' : tab === 'sat' ? 'Saturation' : 'Luminance'}`}
          />
        );
      })}
    </Section>
  );
}
