import type { PartialParams } from './params';

export interface BuiltinPreset {
  id: string;
  group: string;
  name: string;
  params: PartialParams;
}

const g = (h: number, s: number, l = 0) => ({ h, s, l });
const curve = (pts: [number, number][]) => ({
  region: { highlights: 0, lights: 0, darks: 0, shadows: 0 },
  splits: [25, 50, 75] as [number, number, number],
  points: { rgb: pts, r: [[0, 0], [1, 1]] as [number, number][], g: [[0, 0], [1, 1]] as [number, number][], b: [[0, 0], [1, 1]] as [number, number][] },
});

const neutralWheels = { shadows: g(0, 0), midtones: g(0, 0), highlights: g(0, 0), global: g(0, 0), blending: 50, balance: 0 };

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: 'bw-classic',
    group: 'Black & White',
    name: 'Classic',
    params: { treatment: 'bw', contrast: 15, bwMix: [10, 5, 0, -10, -15, -20, -10, 0], clarity: 10 },
  },
  {
    id: 'bw-high-contrast',
    group: 'Black & White',
    name: 'High Contrast',
    params: {
      treatment: 'bw',
      contrast: 45,
      whites: 20,
      blacks: -25,
      clarity: 25,
      bwMix: [20, 15, 5, -20, -30, -40, -20, 0],
      toneCurve: curve([[0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]]),
    },
  },
  {
    id: 'bw-soft',
    group: 'Black & White',
    name: 'Soft Matte',
    params: { treatment: 'bw', contrast: -15, toneCurve: curve([[0, 0.08], [0.5, 0.52], [1, 0.95]]) },
  },
  {
    id: 'color-vivid',
    group: 'Color',
    name: 'Vivid',
    params: { treatment: 'color', vibrance: 35, saturation: 8, contrast: 20, clarity: 10 },
  },
  {
    id: 'color-warm-film',
    group: 'Color',
    name: 'Warm Film',
    params: {
      treatment: 'color',
      contrast: -10,
      vibrance: -10,
      toneCurve: curve([[0, 0.05], [0.25, 0.24], [0.75, 0.78], [1, 0.96]]),
      grading: { ...neutralWheels, shadows: g(200, 12), highlights: g(40, 18), balance: 10 },
      effects: { vignetteAmount: -12, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 60, grainAmount: 20, grainSize: 25, grainRoughness: 50 },
    },
  },
  {
    id: 'color-teal-orange',
    group: 'Color',
    name: 'Teal & Orange',
    params: {
      treatment: 'color',
      contrast: 15,
      vibrance: 15,
      grading: { ...neutralWheels, shadows: g(195, 30), highlights: g(35, 25), balance: 0 },
      hsl: { hue: [0, -5, -10, 20, 10, -10, 0, 0], sat: [0, 15, -20, -30, 10, 10, -20, -20], lum: [0, 5, 0, -10, 0, -10, 0, 0] },
    },
  },
  {
    id: 'color-cool-matte',
    group: 'Color',
    name: 'Cool Matte',
    params: {
      treatment: 'color',
      contrast: -20,
      saturation: -15,
      toneCurve: curve([[0, 0.1], [0.5, 0.5], [1, 0.92]]),
      grading: { ...neutralWheels, global: g(210, 10), shadows: g(220, 15) },
    },
  },
  {
    id: 'landscape-punchy',
    group: 'Landscape',
    name: 'Punchy',
    params: { treatment: 'color', contrast: 25, highlights: -40, shadows: 30, clarity: 20, dehaze: 10, vibrance: 30 },
  },
  {
    id: 'landscape-haze-cut',
    group: 'Landscape',
    name: 'Haze Cut',
    params: { treatment: 'color', dehaze: 35, highlights: -20, vibrance: 10, contrast: 5 },
  },
  {
    id: 'portrait-soft',
    group: 'Portrait',
    name: 'Soft Skin',
    params: { treatment: 'color', texture: -25, clarity: -10, highlights: -15, shadows: 15, vibrance: 5 },
  },
  {
    id: 'basic-recover',
    group: 'Basic',
    name: 'Recover Highlights & Shadows',
    params: { treatment: 'color', highlights: -70, shadows: 55, whites: 10, blacks: -10 },
  },
];
