import { describe, expect, it } from 'vitest';
import {
  defaultParams, normalizeParams, pickSections, applyPartial, paramsEqual, newMask, migrateParams,
  PARAMS_VERSION, DEFAULT_SHAPE_FEATHER, MAX_SHAPE_POINTS, defaultLocalAdjustments,
  rectPolygon, ellipsePolygon, simplifyPolyline, polygonBounds, polygonCenter, isAllZero,
  camToPro, srgbSourceColor, multipliersFor, asShotTempTint, xyToTempTint, planckianXY, tempTintToXY,
  SRGB_TO_PRO, PRO_TO_SRGB, mulVec, mul3, inv3, IDENTITY, srgbEncode, srgbDecode, tempFromSlider, sliderFromTemp,
  monotoneSpline, bakeCurveLUT, parametricCurve,
  cropToSource, sourceToCrop, constrainCrop, maxCrop, frameToSource, sourceToFrame, cropPixelDims,
  BUILTIN_PRESETS, type Mat3,
  patchN, maskBounds, MAX_PATCHES,
} from './index';

const close = (a: number, b: number, eps = 1e-4) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('params', () => {
  it('normalizes garbage to defaults', () => {
    const p = normalizeParams({ exposure: 'x', contrast: 500, masks: [{ kind: 'nope' }], geometry: { rotate: 7 } });
    expect(p.exposure).toBe(0);
    expect(p.contrast).toBe(100);
    expect(p.masks).toEqual([]);
    expect(p.geometry.rotate).toBe(3);
  });
  it('round-trips through JSON', () => {
    const p = defaultParams({ isRaw: true, asShotTemp: 5200, asShotTint: 4 });
    p.masks.push(newMask('radial', 0));
    p.exposure = 1.25;
    const q = normalizeParams(JSON.parse(JSON.stringify(p)), defaultParams({ isRaw: true, asShotTemp: 5200, asShotTint: 4 }));
    expect(paramsEqual(p, q)).toBe(true);
  });
  it('as-shot WB always follows the source', () => {
    const base = defaultParams({ asShotTemp: 4000, asShotTint: 10 });
    const p = normalizeParams({ wb: { mode: 'asShot', temp: 9999, tint: 0 } }, base);
    expect(p.wb.temp).toBe(4000);
  });
  it('copies only selected sections', () => {
    const a = defaultParams();
    a.exposure = 2; a.clarity = 30; a.hsl.sat[2] = 40;
    const part = pickSections(a, ['basicTone']);
    const b = applyPartial(defaultParams(), part, defaultParams());
    expect(b.exposure).toBe(2);
    expect(b.clarity).toBe(0);
    expect(b.hsl.sat[2]).toBe(0);
  });
  it('normalizes spots', () => {
    const p = normalizeParams({ spots: [{ x: 0.2, y: 0.3, sx: 0.4, sy: 0.3, r: 0.02, mode: 'clone' }, { nope: 1 }] });
    expect(p.spots).toHaveLength(1);
    expect(p.spots[0].mode).toBe('clone');
    expect(p.spots[0].feather).toBe(0.5);
  });
  it('all builtin presets normalize', () => {
    for (const pr of BUILTIN_PRESETS) {
      const p = applyPartial(defaultParams(), pr.params, defaultParams());
      expect(p.version).toBe(PARAMS_VERSION);
    }
  });
  it('builtin presets set treatment explicitly', () => {
    for (const pr of BUILTIN_PRESETS) {
      expect(pr.params.treatment).toBe(pr.group === 'Black & White' ? 'bw' : 'color');
    }
  });
});

describe('shape masks', () => {
  it('names new selections and round-trips through JSON', () => {
    const m = newMask('shape', 2);
    expect(m.name).toBe('Selection 3');
    expect(m.shape).toEqual({ points: [], feather: DEFAULT_SHAPE_FEATHER });
    const p = defaultParams();
    m.shape.points = [[0.1, 0.1], [0.5, 0.1], [0.3, 0.6]];
    p.masks.push(m);
    const q = normalizeParams(JSON.parse(JSON.stringify(p)));
    expect(paramsEqual(p, q)).toBe(true);
  });
  it('normalizes shape masks and clamps feather/points', () => {
    const p = normalizeParams({
      version: PARAMS_VERSION,
      masks: [{ kind: 'shape', shape: { points: [[0.1, 0.2], [5, -3], [0.4, 0.9]], feather: 9 } }],
    });
    expect(p.masks).toHaveLength(1);
    expect(p.masks[0].kind).toBe('shape');
    expect(p.masks[0].shape.feather).toBe(0.5);
    expect(p.masks[0].shape.points).toEqual([[0.1, 0.2], [2, -1], [0.4, 0.9]]);
  });
  it('drops garbage shape points', () => {
    const p = normalizeParams({ version: PARAMS_VERSION, masks: [{ kind: 'shape', shape: { points: 'x' } }] });
    expect(p.masks[0].shape.points).toEqual([]);
    const q = normalizeParams({ version: PARAMS_VERSION, masks: [{ kind: 'shape', shape: { points: [1, ['a', 2], [0.5]] } }] });
    expect(q.masks[0].shape.points).toEqual([]);
    expect(q.masks[0].shape.feather).toBe(DEFAULT_SHAPE_FEATHER);
  });
  it('caps shape points', () => {
    const many = Array.from({ length: MAX_SHAPE_POINTS + 50 }, (_, i) => [i / 5000, 0.5]);
    const p = normalizeParams({ version: PARAMS_VERSION, masks: [{ kind: 'shape', shape: { points: many } }] });
    expect(p.masks[0].shape.points).toHaveLength(MAX_SHAPE_POINTS);
  });
  it('migrates v1 docs to v2 with a default shape', () => {
    const v1 = { version: 1, masks: [{ id: 'a', kind: 'radial', name: 'R' }] };
    const mig = migrateParams(v1) as { version: number; masks: { shape: unknown }[] };
    expect(mig.version).toBe(PARAMS_VERSION);
    expect(mig.masks[0].shape).toEqual({ points: [], feather: DEFAULT_SHAPE_FEATHER });
    expect(v1.masks[0]).not.toHaveProperty('shape');
    const p = normalizeParams(v1);
    expect(p.version).toBe(PARAMS_VERSION);
    expect(p.masks[0].shape).toEqual({ points: [], feather: DEFAULT_SHAPE_FEATHER });
  });
});

describe('selection helpers', () => {
  it('rectPolygon orders corners', () => {
    expect(rectPolygon([10, 20], [0, 5])).toEqual([[0, 5], [10, 5], [10, 20], [0, 20]]);
  });
  it('ellipsePolygon has the right radii', () => {
    const pts = ellipsePolygon([0, 0], [20, 10], 64);
    expect(pts).toHaveLength(64);
    const b = polygonBounds(pts);
    close(b.minX, 0); close(b.maxX, 20); close(b.minY, 0); close(b.maxY, 10);
    for (const [x, y] of pts) close(((x - 10) / 10) ** 2 + ((y - 5) / 5) ** 2, 1, 1e-9);
  });
  it('simplifyPolyline collapses collinear points and keeps corners', () => {
    const line: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
    expect(simplifyPolyline(line, 0.5)).toEqual([[0, 0], [4, 0]]);
    const corner: [number, number][] = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]];
    expect(simplifyPolyline(corner, 0.5)).toEqual([[0, 0], [2, 0], [2, 2]]);
    const jitter: [number, number][] = [[0, 0], [1, 0.3], [2, -0.2], [3, 0]];
    expect(simplifyPolyline(jitter, 0)).toEqual(jitter);
  });
  it('bounds and center', () => {
    const pts: [number, number][] = [[1, 2], [5, -1], [3, 7]];
    expect(polygonBounds(pts)).toEqual({ minX: 1, minY: -1, maxX: 5, maxY: 7 });
    expect(polygonCenter(pts)).toEqual([3, 3]);
    expect(polygonBounds([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
  it('isAllZero', () => {
    const a = defaultLocalAdjustments();
    expect(isAllZero(a)).toBe(true);
    a.temp = -5;
    expect(isAllZero(a)).toBe(false);
  });
});

describe('color', () => {
  it('inverts matrices', () => {
    const m = mul3(SRGB_TO_PRO, PRO_TO_SRGB);
    m.forEach((v, i) => close(v, IDENTITY[i]));
  });
  it('maps sRGB white to ProPhoto white', () => {
    const w = mulVec(SRGB_TO_PRO, [1, 1, 1]);
    w.forEach((v) => close(v, 1, 1e-3));
  });
  it('srgb transfer round-trips', () => {
    for (const x of [0, 0.001, 0.01, 0.18, 0.5, 1]) close(srgbDecode(srgbEncode(x)), x, 1e-9);
  });
  it('identity camera for sRGB sources', () => {
    const src = srgbSourceColor();
    const m = camToPro(src);
    m.forEach((v, i) => close(v, SRGB_TO_PRO[i], 1e-6));
  });
  it('sRGB as-shot is ~D65', () => {
    const { temp, tint } = asShotTempTint(srgbSourceColor());
    expect(Math.abs(temp - 6504)).toBeLessThan(60);
    expect(Math.abs(tint - 10)).toBeLessThan(3); // D65 is ~+0.0032 Duv off the locus, like Lightroom's +10
  });
  it('temp/tint round trips through xy', () => {
    for (const T of [2500, 3200, 5000, 6500, 9000, 15000]) {
      for (const tint of [-50, 0, 40]) {
        const [x, y] = tempTintToXY(T, tint);
        const r = xyToTempTint(x, y);
        expect(Math.abs(r.temp - T) / T).toBeLessThan(0.01);
        expect(Math.abs(r.tint - tint)).toBeLessThan(1.5);
      }
    }
  });
  it('lower temperature makes the image bluer (boosts blue multiplier)', () => {
    const src = srgbSourceColor();
    const warm = multipliersFor(src, 3000, 0);
    const neutral = multipliersFor(src, 6504, 10);
    expect(warm[2]).toBeGreaterThan(neutral[2]);
    close(neutral[0], 1, 0.02);
    close(neutral[2], 1, 0.02);
  });
  it('positive tint compensates towards magenta (reduces green relative)', () => {
    const src = srgbSourceColor();
    const m0 = multipliersFor(src, 6504, 0);
    const m1 = multipliersFor(src, 6504, 50);
    // green fixed at 1, so magenta = red and blue multipliers increase
    expect(m1[0]).toBeGreaterThan(m0[0]);
    expect(m1[2]).toBeGreaterThan(m0[2]);
  });
  it('planckian locus is sane', () => {
    const [x, y] = planckianXY(6504);
    close(x, 0.3135, 2e-3);
    close(y, 0.3237, 2e-3);
  });
  it('raw camera matrix: balanced neutral maps to white', () => {
    // a plausible camera matrix (Canon-like, D65)
    const xyzToCam: Mat3 = [0.6461, -0.0907, -0.0882, -0.4300, 1.2184, 0.2378, -0.0819, 0.1944, 0.5931];
    const src = { xyzToCam, asShotMul: [2.0, 1, 1.5] as [number, number, number], isRaw: true };
    const m = camToPro(src);
    const w = mulVec(m, [1, 1, 1]);
    w.forEach((v) => close(v, 1, 1e-3));
    // as-shot temp is computed and the multipliers round trip
    const { temp, tint } = asShotTempTint(src);
    const mul = multipliersFor(src, temp, tint);
    close(mul[0], 2.0, 0.05);
    close(mul[2], 1.5, 0.05);
  });
  it('temperature slider mapping inverts', () => {
    for (const t of [0, 0.3, 0.7, 1]) close(sliderFromTemp(tempFromSlider(t)), t, 1e-9);
  });
  it('matrix inverse', () => {
    const m: Mat3 = [2, 1, 0, 0, 1, 3, 1, 0, 1];
    const p = mul3(m, inv3(m));
    p.forEach((v, i) => close(v, IDENTITY[i]));
  });
});

describe('curves', () => {
  it('identity spline', () => {
    const f = monotoneSpline([[0, 0], [1, 1]]);
    for (const x of [0, 0.25, 0.5, 1]) close(f(x), x);
  });
  it('spline is monotone and passes through points', () => {
    const pts: [number, number][] = [[0, 0], [0.2, 0.1], [0.5, 0.6], [0.8, 0.85], [1, 1]];
    const f = monotoneSpline(pts);
    for (const [x, y] of pts) close(f(x), y);
    let prev = -1;
    for (let i = 0; i <= 100; i++) { const v = f(i / 100); expect(v).toBeGreaterThanOrEqual(prev - 1e-12); prev = v; }
  });
  it('identity curve produces no LUT', () => {
    expect(bakeCurveLUT(defaultParams().toneCurve)).toBeNull();
  });
  it('parametric curve lifts shadows', () => {
    const tc = defaultParams().toneCurve;
    tc.region.shadows = 100;
    const f = parametricCurve(tc);
    expect(f(0.12)).toBeGreaterThan(0.13);
    close(f(0), 0, 1e-6);
    close(f(1), 1, 1e-6);
  });
});

describe('geometry', () => {
  const src = { w: 6000, h: 4000 };
  it('frame transforms invert', () => {
    for (const rotate of [0, 1, 2, 3] as const) for (const flipH of [false, true]) {
      const geo = { ...defaultParams().geometry, rotate, flipH };
      const [fu, fv] = sourceToFrame(geo, 0.2, 0.7);
      const [su, sv] = frameToSource(geo, fu, fv);
      close(su, 0.2); close(sv, 0.7);
    }
  });
  it('rotate 90 cw maps top-left to top-right', () => {
    const geo = { ...defaultParams().geometry, rotate: 1 as const };
    const [fu, fv] = sourceToFrame(geo, 0, 0);
    close(fu, 1); close(fv, 0);
  });
  it('crop transforms invert with angle', () => {
    const geo = { ...defaultParams().geometry, angle: 7, rotate: 1 as const, crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } };
    const [su, sv] = cropToSource(geo, src, 0.3, 0.8);
    const [cu, cv] = sourceToCrop(geo, src, su, sv);
    close(cu, 0.3); close(cv, 0.8);
  });
  it('constrains crops inside the rotated image', () => {
    const geo = { ...defaultParams().geometry, angle: 10 };
    const c = constrainCrop(geo, src);
    expect(c.w).toBeLessThan(1);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const [su, sv] = cropToSource({ ...geo, crop: c }, src, u, v);
      expect(su).toBeGreaterThanOrEqual(-1e-4); expect(su).toBeLessThanOrEqual(1 + 1e-4);
      expect(sv).toBeGreaterThanOrEqual(-1e-4); expect(sv).toBeLessThanOrEqual(1 + 1e-4);
    }
  });
  it('max crop keeps aspect', () => {
    const geo = { ...defaultParams().geometry, angle: 5 };
    const c = maxCrop(geo, src, 1);
    const px = cropPixelDims({ ...geo, crop: c }, src);
    close(px.w / px.h, 1, 0.01);
  });
});

const HASH = 'a'.repeat(64);

describe('patches', () => {
  it('migrates v2 docs to v3 with empty patches', () => {
    const mig = migrateParams({ version: 2, exposure: 1 }) as { version: number; patches: unknown };
    expect(mig.version).toBe(3);
    expect(mig.patches).toEqual([]);
    expect(normalizeParams({ version: 2 }).patches).toEqual([]);
    expect(defaultParams().patches).toEqual([]);
  });
  it('rejects bad hashes and missing rects', () => {
    expect(patchN({ asset: 'xyz', rect: [0, 0, 1, 1] })).toBeNull();
    expect(patchN({ asset: 'A'.repeat(64), rect: [0, 0, 1, 1] })).toBeNull();
    expect(patchN({ asset: HASH })).toBeNull();
    expect(patchN({ asset: HASH, rect: [0, 0, 0, 1] })).toBeNull();
    expect(patchN({ asset: HASH, rect: [0, 0, 1, NaN] })).toBeNull();
  });
  it('keeps a valid patch with defaults', () => {
    const p = patchN({ asset: HASH, rect: [0.1, 0.2, 0.3, 0.4] })!;
    expect(p).not.toBeNull();
    expect(p.rect).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(p.area).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(p.opacity).toBe(1);
    expect(p.enabled).toBe(true);
    expect(p.feather).toBe(0.02);
    expect(p.maskId).toBeNull();
    expect(p.ev).toBe(0);
    expect(p.prompt).toBe('');
    expect(typeof p.id).toBe('string');
  });
  it('clamps values', () => {
    const p = patchN({ asset: HASH, rect: [-0.5, 2, 3, 0.5], opacity: 7, ev: 10, feather: 2, maskId: 'm1' })!;
    expect(p.rect).toEqual([0, 1, 1, 0.5]);
    expect(p.opacity).toBe(1);
    expect(p.ev).toBe(4);
    expect(p.feather).toBe(0.5);
    expect(p.maskId).toBe('m1');
    expect(patchN({ asset: HASH, rect: [0, 0, 1, 1], opacity: -1 })!.opacity).toBe(0);
  });
  it('caps at MAX_PATCHES and drops garbage in normalizeParams', () => {
    const many = Array.from({ length: MAX_PATCHES + 5 }, () => ({ asset: HASH, rect: [0, 0, 0.5, 0.5] }));
    const p = normalizeParams({ version: PARAMS_VERSION, patches: [...many, { nope: 1 }] });
    expect(p.patches).toHaveLength(MAX_PATCHES);
  });
  it('pickSections returns patches', () => {
    const p = defaultParams();
    p.patches.push(patchN({ asset: HASH, rect: [0, 0, 1, 1] })!);
    const part = pickSections(p, ['patches']);
    expect(part.patches).toEqual(p.patches);
    expect(Object.keys(part)).toEqual(['patches']);
  });
});

describe('maskBounds', () => {
  const info = { width: 2000, height: 1000 }; // long = width
  it('shape with feather', () => {
    const m = newMask('shape', 0);
    m.shape = { points: [[0.2, 0.3], [0.6, 0.3], [0.4, 0.7]], feather: 0.05 };
    const b = maskBounds(m, info)!;
    close(b.minX, 0.15); close(b.maxX, 0.65);
    close(b.minY, 0.2); close(b.maxY, 0.8);
  });
  it('empty shape is null', () => {
    const m = newMask('shape', 0);
    expect(maskBounds(m, info)).toBeNull();
    m.shape.points = [[0.1, 0.1], [0.2, 0.2]];
    expect(maskBounds(m, info)).toBeNull();
  });
  it('brush unions non-erase strokes', () => {
    const m = newMask('brush', 0);
    m.brush.strokes = [
      { points: [[0.3, 0.3], [0.4, 0.35]], size: 0.02, feather: 0.5, flow: 1, erase: false },
      { points: [[0.6, 0.5]], size: 0.01, feather: 0.5, flow: 1, erase: false },
      { points: [[0.95, 0.95]], size: 0.1, feather: 0.5, flow: 1, erase: true },
    ];
    const b = maskBounds(m, info)!;
    close(b.minX, 0.28); close(b.minY, 0.26);
    close(b.maxX, 0.61); close(b.maxY, 0.52);
    m.brush.strokes = [m.brush.strokes[2]];
    expect(maskBounds(m, info)).toBeNull();
  });
  it('rotated radial', () => {
    const m = newMask('radial', 0);
    m.radial = { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.1, angle: 90, feather: 50 };
    const b = maskBounds(m, info)!;
    close(b.minX, 0.4); close(b.maxX, 0.6); // hx = 0.1 (long units) -> 0.1 UV
    close(b.minY, 0.1); close(b.maxY, 0.9); // hy = 0.2 -> 0.4 UV
    m.radial.angle = 0;
    const c = maskBounds(m, info)!;
    close(c.minX, 0.3); close(c.maxX, 0.7);
    close(c.minY, 0.3); close(c.maxY, 0.7);
  });
  it('linear is null', () => {
    expect(maskBounds(newMask('linear', 0), info)).toBeNull();
  });
  it('clamps at the image edge', () => {
    const m = newMask('radial', 0);
    m.radial = { cx: 0.05, cy: 0.5, rx: 0.1, ry: 0.1, angle: 0, feather: 50 };
    const b = maskBounds(m, info)!;
    expect(b.minX).toBe(0);
    close(b.maxX, 0.15);
    const off = newMask('shape', 0);
    off.shape = { points: [[1.2, 0.2], [1.5, 0.2], [1.4, 0.5]], feather: 0 };
    expect(maskBounds(off, info)).toBeNull();
  });
});
