import { defaultParams, newMask, type EditParams } from '@darkroom/core';
import { describe, expect, it } from 'vitest';
import { ADJUST_TOOL, applyPatch, compactParams, deepMergeParams, sanitizePatch, SYSTEM_PROMPT, validateToolInput } from './ai';

const base = defaultParams({ isRaw: true, asShotTemp: 5200, asShotTint: 8 });

describe('AI edit patches', () => {
  it('deep merge keeps sibling fields and does not mutate inputs', () => {
    const before = structuredClone(base);
    const partial = { detail: { sharpAmount: 50 } };
    const out = deepMergeParams(base, partial);
    expect(out.detail.sharpAmount).toBe(50);
    expect(out.detail.sharpRadius).toBe(base.detail.sharpRadius);
    expect(out.detail.nrColor).toBe(base.detail.nrColor);
    expect(base).toEqual(before);
    expect(partial).toEqual({ detail: { sharpAmount: 50 } });
  });

  it('arrays replace wholesale', () => {
    const p = structuredClone(base);
    p.hsl.sat = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = deepMergeParams(p, { hsl: { sat: [0, 0, 0, 0, 0, 9, 0, 0] } });
    expect(out.hsl.sat).toEqual([0, 0, 0, 0, 0, 9, 0, 0]);
    expect(out.hsl.hue).toEqual(p.hsl.hue);
  });

  it('clamps through normalizeParams', () => {
    const { params } = applyPatch(base, base, { exposure: 12, detail: { sharpRadius: 9 }, grading: { global: { h: 400 } } });
    expect(params.exposure).toBe(5);
    expect(params.detail.sharpRadius).toBe(3);
    expect(params.grading.global.h).toBe(360);
    expect(params.detail.sharpAmount).toBe(base.detail.sharpAmount);
  });

  it('drops and reports unknown keys; rejects mask arrays and spots', () => {
    const committed: EditParams = structuredClone(base);
    committed.spots = [{ id: 's', mode: 'heal', x: 0.5, y: 0.5, sx: 0.2, sy: 0.2, r: 0.01, feather: 0.5, opacity: 1 }];
    const { params, dropped } = applyPatch(committed, base, {
      foo: 1,
      detail: { bogus: 3, nrLuma: 20 },
      masks: [],
      spots: [],
      version: 99,
    });
    expect(dropped).toEqual(expect.arrayContaining(['foo', 'detail.bogus', 'masks', 'spots', 'version']));
    expect(params.detail.nrLuma).toBe(20);
    expect(params.spots).toHaveLength(1);
    expect((params as unknown as Record<string, unknown>).foo).toBeUndefined();
  });

  it('maps band objects to the right index', () => {
    const { params } = applyPatch(base, base, { hsl: { sat: { blue: -40 } }, bwMix: { red: 25 } });
    expect(params.hsl.sat[5]).toBe(-40);
    expect(params.hsl.sat.filter((v, i) => i !== 5 && v !== 0)).toHaveLength(0);
    expect(params.bwMix[0]).toBe(25);
    // other bands come from the committed params
    const committed = structuredClone(base);
    committed.hsl.sat[0] = 30;
    expect(applyPatch(committed, base, { hsl: { sat: { blue: 10 } } }).params.hsl.sat).toEqual([30, 0, 0, 0, 0, 10, 0, 0]);
  });

  it('white balance: temp without a mode is custom; asShot snaps back to base', () => {
    const warm = applyPatch(base, base, { wb: { temp: 6500 } }).params;
    expect(warm.wb).toEqual({ mode: 'custom', temp: 6500, tint: base.wb.tint });
    const back = applyPatch(warm, base, { wb: { mode: 'asShot' } }).params;
    expect(back.wb).toEqual({ mode: 'asShot', temp: 5200, tint: 8 });
  });

  it('tolerates partial streaming snapshots', () => {
    const { params, dropped } = applyPatch(base, base, { treatment: 'b', exposure: NaN, contrast: 10 });
    expect(params.treatment).toBe('color');
    expect(params.exposure).toBe(base.exposure);
    expect(params.contrast).toBe(10);
    expect(dropped).toEqual(expect.arrayContaining(['treatment', 'exposure']));
    expect(applyPatch(base, base, undefined).params).toEqual(base);
    expect(sanitizePatch({ grading: { shadows: {} } }, base).partial).toEqual({});
  });

  it('compact params round-trip through a patch', () => {
    const p = applyPatch(base, base, { exposure: 0.7, hsl: { lum: { green: -15 } }, wb: { temp: 6000 } }).params;
    expect(applyPatch(base, base, compactParams(p)).params).toEqual(p);
  });

  it('validates tool input shape', () => {
    expect(validateToolInput({ patch: {}, summary: 'x' })).not.toBeNull();
    expect(validateToolInput({ patch: [], summary: 'x' })).toBeNull();
    expect(validateToolInput({ patch: {} })).toBeNull();
    expect(validateToolInput('nope')).toBeNull();
  });

  it('tool schema and prompt', () => {
    const schema = JSON.stringify(ADJUST_TOOL.input_schema);
    expect(schema).toContain('"masks"');
    const props = (ADJUST_TOOL.input_schema.properties as Record<string, { properties: Record<string, unknown> }>).patch.properties;
    const entry = (props.masks as { additionalProperties: { properties: { adj: { properties: { exposure: { maximum: number } } } } } }).additionalProperties;
    expect(entry.properties.adj.properties.exposure.maximum).toBe(4);
    expect(SYSTEM_PROMPT).toContain('masks.<id>');
    expect(schema).not.toContain('spots');
    expect(ADJUST_TOOL.name).toBe('adjust_settings');
    expect(ADJUST_TOOL.eager_input_streaming).toBe(true);
    expect(ADJUST_TOOL.strict).toBeUndefined();
    expect(SYSTEM_PROMPT).toContain('adjust_settings');
  });
});

function withMasks(): EditParams {
  const p = structuredClone(base);
  const sel = newMask('shape', 0);
  sel.id = 'sel';
  sel.shape = { points: [[0.1, 0.1], [0.6, 0.1], [0.4, 0.7]], feather: 0.03 };
  const rad = newMask('radial', 1);
  rad.id = 'rad';
  rad.adj.exposure = 0.5;
  p.masks = [sel, rad];
  return p;
}

describe('AI mask patches', () => {
  it('merges by id and keeps geometry, order and other masks', () => {
    const committed = withMasks();
    const { params, dropped } = applyPatch(committed, base, { masks: { sel: { adj: { exposure: 1, temp: -20 }, amount: 80 } }, exposure: 0.3 });
    expect(dropped).toEqual([]);
    expect(params.masks.map((m) => m.id)).toEqual(['sel', 'rad']);
    expect(params.masks[0].adj.exposure).toBe(1);
    expect(params.masks[0].adj.temp).toBe(-20);
    expect(params.masks[0].adj.contrast).toBe(0);
    expect(params.masks[0].amount).toBe(80);
    expect(params.masks[0].shape).toEqual(committed.masks[0].shape);
    expect(params.masks[1]).toEqual(committed.masks[1]);
    expect(params.exposure).toBe(0.3);
    expect(committed.masks[0].adj.exposure).toBe(0);
  });

  it('drops unknown mask ids', () => {
    const committed = withMasks();
    const { params, dropped } = applyPatch(committed, base, { masks: { nope: { adj: { exposure: 1 } } } });
    expect(dropped).toEqual(['masks.nope']);
    expect(params.masks).toEqual(committed.masks);
  });

  it('clamps local values', () => {
    const { params } = applyPatch(withMasks(), base, { masks: { sel: { adj: { exposure: 9, temp: -400 } } } });
    expect(params.masks[0].adj.exposure).toBe(4);
    expect(params.masks[0].adj.temp).toBe(-100);
  });

  it('ignores read-only fields silently and reports geometry', () => {
    const committed = withMasks();
    const ro = applyPatch(committed, base, { masks: { sel: { id: 'x', name: 'Renamed', kind: 'radial', invert: true } } });
    expect(ro.dropped).toEqual([]);
    expect(ro.params.masks[0].id).toBe('sel');
    expect(ro.params.masks[0].name).toBe(committed.masks[0].name);
    expect(ro.params.masks[0].kind).toBe('shape');
    expect(ro.params.masks[0].invert).toBe(true);
    const geo = applyPatch(committed, base, { masks: { sel: { shape: { points: [] } } } });
    expect(geo.dropped).toEqual(['masks.sel.shape']);
    expect(geo.params.masks[0].shape).toEqual(committed.masks[0].shape);
  });

  it('partial range keeps the other range fields', () => {
    const committed = withMasks();
    committed.masks[0].range.lumMin = 30;
    const { params } = applyPatch(committed, base, { masks: { sel: { range: { mode: 'luminance', lumMax: 80 } } } });
    expect(params.masks[0].range.mode).toBe('luminance');
    expect(params.masks[0].range.lumMin).toBe(30);
    expect(params.masks[0].range.lumMax).toBe(80);
  });

  it('compact params with masks round-trip through a patch', () => {
    const committed = withMasks();
    const p = applyPatch(committed, base, { masks: { sel: { adj: { exposure: 0.7 }, invert: true }, rad: { range: { mode: 'color', hue: 200 } } } }).params;
    const compact = compactParams(p);
    expect(Object.keys(compact.masks as object)).toEqual(['sel', 'rad']);
    expect(JSON.stringify(compact)).not.toContain('points');
    expect(applyPatch(committed, base, compact).params).toEqual(p);
  });
});
