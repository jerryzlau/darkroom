/**
 * EditParams: the complete, versioned description of how a photo is developed.
 * A photo's pixels are never modified; the renderer is a pure function of
 * (source pixels, EditParams). Presets, history, copy/paste and sidecars all
 * operate on this document.
 *
 * Units follow Lightroom conventions where possible: most sliders are -100..100,
 * exposure is in stops, temperature in Kelvin.
 */

export const PARAMS_VERSION = 3;

export type Pt = [number, number];

/** Hue bands used by the color mixer, B&W mixer. */
export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslBand = (typeof HSL_BANDS)[number];
/** Band centers in degrees (HSV hue). */
export const HSL_BAND_CENTERS = [0, 30, 60, 120, 180, 240, 270, 300];

export interface WheelHSL {
  h: number; // 0..360
  s: number; // 0..100
  l: number; // -100..100
}

export interface BrushStroke {
  /** Points in source image UV (0..1). */
  points: Pt[];
  /** Brush radius as a fraction of the image's long edge. */
  size: number;
  /** 0..1, fraction of the radius that is soft. */
  feather: number;
  /** 0..1 opacity per stroke. */
  flow: number;
  erase: boolean;
}

export type MaskKind = 'linear' | 'radial' | 'brush' | 'shape';

/** Default edge softness of a selection shape, as a fraction of the long edge. */
export const DEFAULT_SHAPE_FEATHER = 0.02;
/** Upper bound on stored polygon vertices per selection shape. */
export const MAX_SHAPE_POINTS = 2000;

/** A closed polygon selection (lasso, rectangle or ellipse marquee). */
export interface MaskShape {
  /** Closed polygon vertices in source image UV. */
  points: Pt[];
  /** Edge softness as a fraction of the image's long edge, 0..0.5. */
  feather: number;
}

/** Spot removal: copy (clone) or blend-match (heal) a source circle over a destination circle. */
export interface Spot {
  id: string;
  mode: 'heal' | 'clone';
  /** destination center, source UV */
  x: number;
  y: number;
  /** source center, source UV */
  sx: number;
  sy: number;
  /** radius as a fraction of the long edge */
  r: number;
  feather: number; // 0..1
  opacity: number; // 0..1
}

export const MAX_SPOTS = 32;

/** A generative fill: an sRGB PNG from the patch store composited over `rect` through a mask (or a soft box over `area`). */
export interface Patch {
  id: string;
  /** sha256 hex of the PNG in the patch store */
  asset: string;
  /** region the PNG covers, source UV [x, y, w, h] */
  rect: [number, number, number, number];
  /** bounds of the selection at generation time, source UV; alpha fallback when the mask is gone */
  area: [number, number, number, number];
  maskId: string | null;
  /** edge softness of the `area` fallback, fraction of the long edge, 0..0.5 */
  feather: number;
  opacity: number; // 0..1
  enabled: boolean;
  prompt: string;
  model: string;
  /** exposure offset in stops baked into the render the model saw */
  ev: number;
}

export const MAX_PATCHES = 16;

export interface LocalAdjustments {
  exposure: number; // stops, -4..4
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temp: number; // -100..100 relative
  tint: number;
  saturation: number;
  clarity: number;
  dehaze: number;
  texture: number;
}

export interface RangeMask {
  mode: 'none' | 'luminance' | 'color';
  /** luminance range 0..100 */
  lumMin: number;
  lumMax: number;
  lumFeather: number; // 0..100
  /** color range: target hue (deg) and saturation 0..1 sampled from the image */
  hue: number;
  sat: number;
  amount: number; // 0..100 tolerance
}

export interface Mask {
  id: string;
  name: string;
  enabled: boolean;
  invert: boolean;
  kind: MaskKind;
  /** Overall strength 0..100 */
  amount: number;
  /** linear gradient: full effect at (x0,y0), fading to zero at (x1,y1), source UV */
  linear: { x0: number; y0: number; x1: number; y1: number };
  /** radial: ellipse in source UV, rx/ry as fraction of the long edge, angle in degrees */
  radial: { cx: number; cy: number; rx: number; ry: number; angle: number; feather: number };
  brush: { strokes: BrushStroke[] };
  /** shape: closed polygon selection in source UV */
  shape: MaskShape;
  range: RangeMask;
  adj: LocalAdjustments;
}

export interface Geometry {
  /** 90° clockwise steps applied to the upright source */
  rotate: 0 | 1 | 2 | 3;
  flipH: boolean;
  flipV: boolean;
  /** Straighten angle in degrees, -45..45 */
  angle: number;
  /** Crop rectangle in the rotated frame, normalized to the frame size. */
  crop: { x: number; y: number; w: number; h: number };
  /** Locked aspect ratio (w/h in pixels), or null for free. */
  aspect: number | null;
}

export interface EditParams {
  version: number;
  treatment: 'color' | 'bw';
  wb: { mode: 'asShot' | 'custom'; temp: number; tint: number };
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
  toneCurve: {
    region: { highlights: number; lights: number; darks: number; shadows: number };
    splits: [number, number, number];
    points: { rgb: Pt[]; r: Pt[]; g: Pt[]; b: Pt[] };
  };
  hsl: { hue: number[]; sat: number[]; lum: number[] };
  bwMix: number[];
  grading: {
    shadows: WheelHSL;
    midtones: WheelHSL;
    highlights: WheelHSL;
    global: WheelHSL;
    blending: number; // 0..100
    balance: number; // -100..100
  };
  detail: {
    sharpAmount: number; // 0..150
    sharpRadius: number; // 0.5..3
    sharpDetail: number; // 0..100
    sharpMasking: number; // 0..100
    nrLuma: number; // 0..100
    nrLumaDetail: number; // 0..100
    nrColor: number; // 0..100
    nrColorDetail: number; // 0..100
  };
  lens: {
    distortion: number; // -100..100
    vignette: number; // -100..100 (lens vignetting correction)
    caRed: number; // -100..100
    caBlue: number; // -100..100
  };
  effects: {
    vignetteAmount: number; // -100..100
    vignetteMidpoint: number; // 0..100
    vignetteRoundness: number; // -100..100
    vignetteFeather: number; // 0..100
    grainAmount: number; // 0..100
    grainSize: number; // 0..100
    grainRoughness: number; // 0..100
  };
  geometry: Geometry;
  masks: Mask[];
  spots: Spot[];
  patches: Patch[];
}

export const IDENTITY_CURVE: Pt[] = [
  [0, 0],
  [1, 1],
];

const zeros8 = () => [0, 0, 0, 0, 0, 0, 0, 0];
const wheel = (): WheelHSL => ({ h: 0, s: 0, l: 0 });

export interface SourceKind {
  isRaw: boolean;
  asShotTemp: number;
  asShotTint: number;
}

export function defaultParams(src?: Partial<SourceKind>): EditParams {
  const isRaw = src?.isRaw ?? false;
  return {
    version: PARAMS_VERSION,
    treatment: 'color',
    wb: { mode: 'asShot', temp: src?.asShotTemp ?? 6500, tint: src?.asShotTint ?? 0 },
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    vibrance: 0,
    saturation: 0,
    toneCurve: {
      region: { highlights: 0, lights: 0, darks: 0, shadows: 0 },
      splits: [25, 50, 75],
      points: {
        rgb: clonePts(IDENTITY_CURVE),
        r: clonePts(IDENTITY_CURVE),
        g: clonePts(IDENTITY_CURVE),
        b: clonePts(IDENTITY_CURVE),
      },
    },
    hsl: { hue: zeros8(), sat: zeros8(), lum: zeros8() },
    bwMix: zeros8(),
    grading: {
      shadows: wheel(),
      midtones: wheel(),
      highlights: wheel(),
      global: wheel(),
      blending: 50,
      balance: 0,
    },
    detail: {
      sharpAmount: isRaw ? 40 : 0,
      sharpRadius: 1.0,
      sharpDetail: 25,
      sharpMasking: 0,
      nrLuma: 0,
      nrLumaDetail: 50,
      nrColor: isRaw ? 25 : 0,
      nrColorDetail: 50,
    },
    lens: { distortion: 0, vignette: 0, caRed: 0, caBlue: 0 },
    effects: {
      vignetteAmount: 0,
      vignetteMidpoint: 50,
      vignetteRoundness: 0,
      vignetteFeather: 50,
      grainAmount: 0,
      grainSize: 25,
      grainRoughness: 50,
    },
    geometry: defaultGeometry(),
    masks: [],
    spots: [],
    patches: [],
  };
}

export function defaultGeometry(): Geometry {
  return { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: null };
}

export function defaultLocalAdjustments(): LocalAdjustments {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temp: 0,
    tint: 0,
    saturation: 0,
    clarity: 0,
    dehaze: 0,
    texture: 0,
  };
}

export function defaultRange(): RangeMask {
  return { mode: 'none', lumMin: 0, lumMax: 100, lumFeather: 20, hue: 0, sat: 0.5, amount: 50 };
}

let maskCounter = 0;
export function newMaskId(): string {
  maskCounter += 1;
  return `m${Date.now().toString(36)}${maskCounter.toString(36)}`;
}

export function newPatchId(): string {
  maskCounter += 1;
  return `p${Date.now().toString(36)}${maskCounter.toString(36)}`;
}

const MASK_KIND_NAMES: Record<MaskKind, string> = {
  linear: 'Linear Gradient',
  radial: 'Radial Gradient',
  brush: 'Brush',
  shape: 'Selection',
};

export function newMask(kind: MaskKind, index: number): Mask {
  return {
    id: newMaskId(),
    name: `${MASK_KIND_NAMES[kind]} ${index + 1}`,
    enabled: true,
    invert: false,
    kind,
    amount: 100,
    linear: { x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.5 },
    radial: { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.18, angle: 0, feather: 50 },
    brush: { strokes: [] },
    shape: { points: [], feather: DEFAULT_SHAPE_FEATHER },
    range: defaultRange(),
    adj: defaultLocalAdjustments(),
  };
}

function clonePts(p: Pt[]): Pt[] {
  return p.map(([x, y]) => [x, y]);
}

export function cloneParams(p: EditParams): EditParams {
  return structuredClone(p);
}

// ---------------------------------------------------------------------------
// Validation / normalization. Anything coming from disk, presets, or sidecars
// goes through normalizeParams so the renderer can trust the shape.
// ---------------------------------------------------------------------------

const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function numArr(v: unknown, d: number[], min: number, max: number): number[] {
  if (!Array.isArray(v)) return [...d];
  return d.map((dv, i) => num(v[i], dv, min, max));
}

function pts(v: unknown): Pt[] {
  if (!Array.isArray(v)) return clonePts(IDENTITY_CURVE);
  const out: Pt[] = [];
  for (const p of v) {
    if (Array.isArray(p) && p.length >= 2) out.push([num(p[0], 0, 0, 1), num(p[1], 0, 0, 1)]);
  }
  if (out.length < 2) return clonePts(IDENTITY_CURVE);
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function wheelN(v: unknown): WheelHSL {
  const o = obj(v);
  return { h: num(o.h, 0, 0, 360), s: num(o.s, 0, 0, 100), l: num(o.l, 0, -100, 100) };
}

function localN(v: unknown): LocalAdjustments {
  const o = obj(v);
  const d = defaultLocalAdjustments();
  return {
    exposure: num(o.exposure, d.exposure, -4, 4),
    contrast: num(o.contrast, 0, -100, 100),
    highlights: num(o.highlights, 0, -100, 100),
    shadows: num(o.shadows, 0, -100, 100),
    whites: num(o.whites, 0, -100, 100),
    blacks: num(o.blacks, 0, -100, 100),
    temp: num(o.temp, 0, -100, 100),
    tint: num(o.tint, 0, -100, 100),
    saturation: num(o.saturation, 0, -100, 100),
    clarity: num(o.clarity, 0, -100, 100),
    dehaze: num(o.dehaze, 0, -100, 100),
    texture: num(o.texture, 0, -100, 100),
  };
}

function maskN(v: unknown, i: number): Mask | null {
  const o = obj(v);
  const kind = o.kind;
  if (kind !== 'linear' && kind !== 'radial' && kind !== 'brush' && kind !== 'shape') return null;
  const base = newMask(kind, i);
  const lin = obj(o.linear);
  const rad = obj(o.radial);
  const br = obj(o.brush);
  const rg = obj(o.range);
  const sh = obj(o.shape);
  const shapePts: Pt[] = Array.isArray(sh.points)
    ? (sh.points as unknown[])
        .filter((p): p is unknown[] => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number')
        .slice(0, MAX_SHAPE_POINTS)
        .map((p) => [num(p[0], 0, -1, 2), num(p[1], 0, -1, 2)] as Pt)
    : [];
  const strokes: BrushStroke[] = Array.isArray(br.strokes)
    ? (br.strokes as unknown[]).map((s) => {
        const so = obj(s);
        return {
          points: Array.isArray(so.points)
            ? (so.points as unknown[])
                .filter((p): p is number[] => Array.isArray(p) && p.length >= 2)
                .map((p) => [num(p[0], 0), num(p[1], 0)] as Pt)
            : [],
          size: num(so.size, 0.05, 0.001, 1),
          feather: num(so.feather, 0.5, 0, 1),
          flow: num(so.flow, 1, 0, 1),
          erase: bool(so.erase, false),
        };
      })
    : [];
  const mode = rg.mode === 'luminance' || rg.mode === 'color' ? rg.mode : 'none';
  return {
    id: typeof o.id === 'string' ? o.id : base.id,
    name: typeof o.name === 'string' ? o.name : base.name,
    enabled: bool(o.enabled, true),
    invert: bool(o.invert, false),
    kind,
    amount: num(o.amount, 100, 0, 100),
    linear: {
      x0: num(lin.x0, base.linear.x0),
      y0: num(lin.y0, base.linear.y0),
      x1: num(lin.x1, base.linear.x1),
      y1: num(lin.y1, base.linear.y1),
    },
    radial: {
      cx: num(rad.cx, base.radial.cx),
      cy: num(rad.cy, base.radial.cy),
      rx: num(rad.rx, base.radial.rx, 0.001, 4),
      ry: num(rad.ry, base.radial.ry, 0.001, 4),
      angle: num(rad.angle, 0, -360, 360),
      feather: num(rad.feather, 50, 0, 100),
    },
    brush: { strokes },
    shape: { points: shapePts, feather: num(sh.feather, DEFAULT_SHAPE_FEATHER, 0, 0.5) },
    range: {
      mode,
      lumMin: num(rg.lumMin, 0, 0, 100),
      lumMax: num(rg.lumMax, 100, 0, 100),
      lumFeather: num(rg.lumFeather, 20, 0, 100),
      hue: num(rg.hue, 0, 0, 360),
      sat: num(rg.sat, 0.5, 0, 1),
      amount: num(rg.amount, 50, 0, 100),
    },
    adj: localN(o.adj),
  };
}

/** Bring any version of stored params up to the current version. */
export function migrateParams(input: unknown): unknown {
  const o = { ...obj(input) };
  const version = typeof o.version === 'number' ? o.version : 1;
  if (version < 2) {
    // v2 added the 'shape' mask kind; every mask carries a (possibly empty) shape.
    if (Array.isArray(o.masks)) {
      o.masks = (o.masks as unknown[]).map((m) =>
        m && typeof m === 'object' && !Array.isArray(m) && !('shape' in m)
          ? { ...m, shape: { points: [], feather: DEFAULT_SHAPE_FEATHER } }
          : m,
      );
    }
    o.version = 2;
  }
  if (version < 3) {
    // v3 added generative fill patches.
    if (!Array.isArray(o.patches)) o.patches = [];
    o.version = 3;
  }
  return o;
}

/**
 * Validate and fill defaults. `base` supplies source-dependent defaults
 * (as-shot white balance, raw sharpening defaults).
 */
export function normalizeParams(input: unknown, base: EditParams = defaultParams()): EditParams {
  const o = obj(migrateParams(input));
  const d = base;
  const wb = obj(o.wb);
  const tc = obj(o.toneCurve);
  const tcr = obj(tc.region);
  const tcp = obj(tc.points);
  const hsl = obj(o.hsl);
  const gr = obj(o.grading);
  const de = obj(o.detail);
  const le = obj(o.lens);
  const ef = obj(o.effects);
  const ge = obj(o.geometry);
  const crop = obj(ge.crop);
  const splitsIn = Array.isArray(tc.splits) ? tc.splits : d.toneCurve.splits;
  const s0 = num(splitsIn[0], 25, 5, 45);
  const s1 = num(splitsIn[1], 50, s0 + 5, 90);
  const s2 = num(splitsIn[2], 75, s1 + 5, 95);
  const rot = num(ge.rotate, 0, 0, 3);
  const masks = Array.isArray(o.masks)
    ? (o.masks as unknown[]).map((m, i) => maskN(m, i)).filter((m): m is Mask => m !== null)
    : [];
  const cw = num(crop.w, 1, 0.01, 1);
  const ch = num(crop.h, 1, 0.01, 1);
  return {
    version: PARAMS_VERSION,
    treatment: o.treatment === 'bw' ? 'bw' : 'color',
    wb: {
      mode: wb.mode === 'custom' ? 'custom' : 'asShot',
      temp: wb.mode === 'custom' ? num(wb.temp, d.wb.temp, 2000, 50000) : d.wb.temp,
      tint: wb.mode === 'custom' ? num(wb.tint, d.wb.tint, -150, 150) : d.wb.tint,
    },
    exposure: num(o.exposure, d.exposure, -5, 5),
    contrast: num(o.contrast, d.contrast, -100, 100),
    highlights: num(o.highlights, d.highlights, -100, 100),
    shadows: num(o.shadows, d.shadows, -100, 100),
    whites: num(o.whites, d.whites, -100, 100),
    blacks: num(o.blacks, d.blacks, -100, 100),
    texture: num(o.texture, d.texture, -100, 100),
    clarity: num(o.clarity, d.clarity, -100, 100),
    dehaze: num(o.dehaze, d.dehaze, -100, 100),
    vibrance: num(o.vibrance, d.vibrance, -100, 100),
    saturation: num(o.saturation, d.saturation, -100, 100),
    toneCurve: {
      region: {
        highlights: num(tcr.highlights, 0, -100, 100),
        lights: num(tcr.lights, 0, -100, 100),
        darks: num(tcr.darks, 0, -100, 100),
        shadows: num(tcr.shadows, 0, -100, 100),
      },
      splits: [s0, s1, s2],
      points: { rgb: pts(tcp.rgb), r: pts(tcp.r), g: pts(tcp.g), b: pts(tcp.b) },
    },
    hsl: {
      hue: numArr(hsl.hue, d.hsl.hue, -100, 100),
      sat: numArr(hsl.sat, d.hsl.sat, -100, 100),
      lum: numArr(hsl.lum, d.hsl.lum, -100, 100),
    },
    bwMix: numArr(o.bwMix, d.bwMix, -100, 100),
    grading: {
      shadows: wheelN(gr.shadows),
      midtones: wheelN(gr.midtones),
      highlights: wheelN(gr.highlights),
      global: wheelN(gr.global),
      blending: num(gr.blending, 50, 0, 100),
      balance: num(gr.balance, 0, -100, 100),
    },
    detail: {
      sharpAmount: num(de.sharpAmount, d.detail.sharpAmount, 0, 150),
      sharpRadius: num(de.sharpRadius, d.detail.sharpRadius, 0.5, 3),
      sharpDetail: num(de.sharpDetail, d.detail.sharpDetail, 0, 100),
      sharpMasking: num(de.sharpMasking, d.detail.sharpMasking, 0, 100),
      nrLuma: num(de.nrLuma, d.detail.nrLuma, 0, 100),
      nrLumaDetail: num(de.nrLumaDetail, d.detail.nrLumaDetail, 0, 100),
      nrColor: num(de.nrColor, d.detail.nrColor, 0, 100),
      nrColorDetail: num(de.nrColorDetail, d.detail.nrColorDetail, 0, 100),
    },
    lens: {
      distortion: num(le.distortion, 0, -100, 100),
      vignette: num(le.vignette, 0, -100, 100),
      caRed: num(le.caRed, 0, -100, 100),
      caBlue: num(le.caBlue, 0, -100, 100),
    },
    effects: {
      vignetteAmount: num(ef.vignetteAmount, 0, -100, 100),
      vignetteMidpoint: num(ef.vignetteMidpoint, 50, 0, 100),
      vignetteRoundness: num(ef.vignetteRoundness, 0, -100, 100),
      vignetteFeather: num(ef.vignetteFeather, 50, 0, 100),
      grainAmount: num(ef.grainAmount, 0, 0, 100),
      grainSize: num(ef.grainSize, 25, 0, 100),
      grainRoughness: num(ef.grainRoughness, 50, 0, 100),
    },
    geometry: {
      rotate: (Math.round(rot) % 4) as 0 | 1 | 2 | 3,
      flipH: bool(ge.flipH, false),
      flipV: bool(ge.flipV, false),
      angle: num(ge.angle, 0, -45, 45),
      crop: {
        x: num(crop.x, 0, 0, 1 - cw),
        y: num(crop.y, 0, 0, 1 - ch),
        w: cw,
        h: ch,
      },
      aspect: typeof ge.aspect === 'number' && ge.aspect > 0 ? ge.aspect : null,
    },
    masks,
    spots: Array.isArray(o.spots) ? (o.spots as unknown[]).map(spotN).filter((x): x is Spot => x !== null).slice(0, MAX_SPOTS) : [],
    patches: Array.isArray(o.patches)
      ? (o.patches as unknown[]).map(patchN).filter((x): x is Patch => x !== null).slice(0, MAX_PATCHES)
      : [],
  };
}

type Rect4 = [number, number, number, number];

function rectN(v: unknown): Rect4 | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const [x, y, w, h] = v as number[];
  if (!(w > 0) || !(h > 0)) return null;
  return [num(x, 0, 0, 1), num(y, 0, 0, 1), num(w, 1, 1e-6, 1), num(h, 1, 1e-6, 1)];
}

export function patchN(v: unknown): Patch | null {
  const o = obj(v);
  if (typeof o.asset !== 'string' || !/^[0-9a-f]{64}$/.test(o.asset)) return null;
  const rect = rectN(o.rect);
  if (!rect) return null;
  return {
    id: typeof o.id === 'string' ? o.id : newMaskId(),
    asset: o.asset,
    rect,
    area: rectN(o.area) ?? [...rect],
    maskId: typeof o.maskId === 'string' ? o.maskId : null,
    feather: num(o.feather, 0.02, 0, 0.5),
    opacity: num(o.opacity, 1, 0, 1),
    enabled: bool(o.enabled, true),
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    model: typeof o.model === 'string' ? o.model : '',
    ev: num(o.ev, 0, -4, 4),
  };
}

function spotN(v: unknown): Spot | null {
  const o = obj(v);
  if (typeof o.x !== 'number' || typeof o.y !== 'number') return null;
  return {
    id: typeof o.id === 'string' ? o.id : newMaskId(),
    mode: o.mode === 'clone' ? 'clone' : 'heal',
    x: num(o.x, 0.5, -1, 2),
    y: num(o.y, 0.5, -1, 2),
    sx: num(o.sx, 0.5, -1, 2),
    sy: num(o.sy, 0.5, -1, 2),
    r: num(o.r, 0.01, 0.0005, 0.5),
    feather: num(o.feather, 0.5, 0, 1),
    opacity: num(o.opacity, 1, 0, 1),
  };
}

// ---------------------------------------------------------------------------
// Sections: used for copy/paste settings, presets, per-panel reset.
// ---------------------------------------------------------------------------

export const SECTIONS = {
  whiteBalance: ['wb'],
  basicTone: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  presence: ['texture', 'clarity', 'dehaze', 'vibrance', 'saturation'],
  treatment: ['treatment', 'bwMix'],
  toneCurve: ['toneCurve'],
  colorMixer: ['hsl'],
  colorGrading: ['grading'],
  detail: ['detail'],
  lens: ['lens'],
  effects: ['effects'],
  crop: ['geometry'],
  spots: ['spots'],
  masks: ['masks'],
  patches: ['patches'],
} as const satisfies Record<string, readonly (keyof EditParams)[]>;

export type SectionName = keyof typeof SECTIONS;

export const SECTION_LABELS: Record<SectionName, string> = {
  whiteBalance: 'White Balance',
  basicTone: 'Basic Tone',
  presence: 'Presence',
  treatment: 'Treatment & B&W Mix',
  toneCurve: 'Tone Curve',
  colorMixer: 'Color Mixer',
  colorGrading: 'Color Grading',
  detail: 'Detail',
  lens: 'Lens Corrections',
  effects: 'Effects',
  crop: 'Crop & Rotation',
  spots: 'Spot Removal',
  masks: 'Masks',
  patches: 'Generative Fill',
};

/** A preset or copied settings: a subset of top-level fields. */
export type PartialParams = Partial<Omit<EditParams, 'version'>>;

export function pickSections(p: EditParams, sections: SectionName[]): PartialParams {
  const out: Record<string, unknown> = {};
  for (const s of sections) {
    for (const key of SECTIONS[s]) out[key] = structuredClone(p[key]);
  }
  return out as PartialParams;
}

export function applyPartial(p: EditParams, partial: PartialParams, base: EditParams): EditParams {
  const merged = { ...cloneParams(p), ...structuredClone(partial) };
  return normalizeParams(merged, base);
}

export function resetSection(p: EditParams, section: SectionName, base: EditParams): EditParams {
  return applyPartial(p, pickSections(base, [section]), base);
}

/** Deep structural equality for params (used to detect "edited" state). */
export function paramsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!paramsEqual(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!paramsEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}

export function isCurveIdentity(p: Pt[]): boolean {
  return p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1;
}
