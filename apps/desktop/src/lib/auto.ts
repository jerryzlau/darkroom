import { camToPro, mulVec, tempTintFromNeutral, wbMultipliers, type EditParams } from '@darkroom/core';
import { grayWorld, type LoadedSource } from '../engine/source';

/** Lightroom-style "Auto" tone: exposure from the median, then protect highlights and shadows. */
export function autoTone(src: LoadedSource, p: EditParams): Partial<EditParams> {
  const m = camToPro(src.color);
  const mul = wbMultipliers(src.color, p.wb);
  const clip = src.color.isRaw ? Math.min(...mul) : Infinity;
  const baseline = src.color.isRaw ? 0.5 : 0;
  const d = src.data;
  const step = Math.max(1, Math.floor(d.length / 3 / 50000)) * 3;
  const ys: number[] = [];
  for (let i = 0; i < d.length; i += step) {
    const c = mulVec(m, [Math.min(d[i] * mul[0], clip), Math.min(d[i + 1] * mul[1], clip), Math.min(d[i + 2] * mul[2], clip)]);
    ys.push(Math.max(0, 0.2880402 * c[0] + 0.7118741 * c[1] + 0.0000857 * c[2]));
  }
  ys.sort((a, b) => a - b);
  const q = (f: number) => ys[Math.min(ys.length - 1, Math.floor(ys.length * f))] ?? 0;
  // geometric mean of the middle half is a robust "key"
  let acc = 0;
  let n = 0;
  for (let i = Math.floor(ys.length * 0.25); i < Math.floor(ys.length * 0.75); i++) {
    acc += Math.log2(ys[i] + 1e-5);
    n++;
  }
  const key = n ? Math.pow(2, acc / n) : 0.18;
  const target = 0.16;
  const exposure = Math.max(-4, Math.min(4, Math.log2(target / Math.max(key * Math.pow(2, baseline), 1e-5))));
  const gain = Math.pow(2, exposure + baseline);
  const hi = q(0.995) * gain;
  const lo = q(0.01) * gain;
  const highlights = hi > 0.9 ? -Math.min(80, Math.round(Math.log2(hi / 0.9) * 35 + 15)) : 0;
  const shadows = lo < 0.004 ? Math.min(60, Math.round(-Math.log2(Math.max(lo, 1e-4) / 0.004) * 9 + 10)) : 0;
  const whites = hi < 0.75 ? Math.round(Math.min(40, (0.75 - hi) * 60)) : 0;
  const blacks = lo > 0.02 ? -Math.round(Math.min(30, lo * 300)) : 0;
  return {
    exposure: Math.round(exposure * 100) / 100,
    contrast: 10,
    highlights,
    shadows,
    whites,
    blacks,
  };
}

export function autoWhiteBalance(src: LoadedSource): { temp: number; tint: number } {
  return tempTintFromNeutral(src.color, grayWorld(src));
}
