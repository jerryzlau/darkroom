import { describe, expect, it } from 'vitest';
import { findHealSource, type Disc } from './healSource';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build an RGBA8 buffer from a per-pixel colour function plus a little noise. */
function makeBuf(w: number, h: number, color: (x: number, y: number) => [number, number, number], noise = 4, seed = 1) {
  const rand = rng(seed);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x + 0.5, y + 0.5);
      const n = (rand() - 0.5) * 2 * noise;
      const i = (y * w + x) * 4;
      px[i] = Math.max(0, Math.min(255, Math.round(r + n)));
      px[i + 1] = Math.max(0, Math.min(255, Math.round(g + n)));
      px[i + 2] = Math.max(0, Math.min(255, Math.round(b + n)));
      px[i + 3] = 255;
    }
  }
  return px;
}

const SKIN: [number, number, number] = [214, 170, 145];
const inDisc = (x: number, y: number, d: Disc) => Math.hypot(x - d.x, y - d.y) < d.r;
const overlaps = (a: Disc, b: Disc) => Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r;

describe('findHealSource', () => {
  it('finds a valid source for a dark dot on flat skin', () => {
    const w = 192;
    const h = 160;
    const dest = { x: 96, y: 80, r: 12 };
    const px = makeBuf(w, h, (x, y) => (inDisc(x, y, { ...dest, r: 7 }) ? [90, 60, 50] : SKIN));
    const t0 = performance.now();
    const res = findHealSource(px, w, h, dest);
    const ms = performance.now() - t0;
    expect(res).not.toBeNull();
    const s = { x: res!.x, y: res!.y, r: dest.r };
    expect(overlaps(s, dest)).toBe(false);
    expect(s.x - s.r).toBeGreaterThanOrEqual(0);
    expect(s.y - s.r).toBeGreaterThanOrEqual(0);
    expect(s.x + s.r).toBeLessThanOrEqual(w);
    expect(s.y + s.r).toBeLessThanOrEqual(h);
    // flat skin: the closest ring wins
    expect(Math.hypot(s.x - dest.x, s.y - dest.y)).toBeCloseTo(2.2 * dest.r, 3);
    expect(ms).toBeLessThan(50); // generous for CI; typically well under 5 ms
  });

  it('avoids a dark eye next to the mark', () => {
    const w = 192;
    const h = 192;
    // the eye sits to the right, where the first (angle 0) candidate would land on a tie
    const dest = { x: 92, y: 96, r: 10 };
    const eye = (x: number, y: number) => ((x - 142) / 30) ** 2 + ((y - 96) / 22) ** 2 < 1;
    const px = makeBuf(w, h, (x, y) => (eye(x, y) ? [40, 30, 28] : inDisc(x, y, { ...dest, r: 6 }) ? [100, 70, 60] : SKIN), 4, 2);
    const res = findHealSource(px, w, h, dest)!;
    expect(res).not.toBeNull();
    // the source disc (plus its blend ring) must not touch the eye
    expect(res.x + dest.r * 1.5).toBeLessThan(112);
  });

  it('respects exclude discs', () => {
    const w = 192;
    const h = 192;
    const dest = { x: 96, y: 96, r: 10 };
    const px = makeBuf(w, h, () => SKIN, 3, 3);
    const free = findHealSource(px, w, h, dest)!;
    const ex = { x: free.x, y: free.y, r: 10 };
    const res = findHealSource(px, w, h, dest, { exclude: [ex] })!;
    expect(res).not.toBeNull();
    expect(overlaps({ x: res.x, y: res.y, r: dest.r }, ex)).toBe(false);
    // excluding every candidate ring leaves nothing
    expect(findHealSource(px, w, h, dest, { exclude: [{ x: 96, y: 96, r: 200 }] })).toBeNull();
  });

  it('returns null when nothing fits', () => {
    const w = 24;
    const h = 24;
    const px = makeBuf(w, h, () => SKIN);
    expect(findHealSource(px, w, h, { x: 12, y: 12, r: 8 })).toBeNull();
    expect(findHealSource(px, w, h, { x: 12, y: 12, r: 0 })).toBeNull();
  });

  for (const axis of ['vertical', 'horizontal'] as const) {
    it(`stays on the iso-brightness line under a ${axis} lighting gradient`, () => {
      const w = 192;
      const h = 192;
      const dest = { x: 96, y: 96, r: 10 };
      const px = makeBuf(
        w,
        h,
        (x, y) => {
          if (inDisc(x, y, { ...dest, r: 6 })) return [80, 55, 45];
          const k = 1.35 - (0.9 * (axis === 'vertical' ? y : x)) / h;
          return [SKIN[0] * k * 0.8, SKIN[1] * k * 0.8, SKIN[2] * k * 0.8];
        },
        3,
        5,
      );
      const res = findHealSource(px, w, h, dest)!;
      expect(res).not.toBeNull();
      // vertical gradient: same row; horizontal gradient: same column
      if (axis === 'vertical') expect(Math.abs(res.y - dest.y)).toBeLessThan(dest.r * 0.6);
      else expect(Math.abs(res.x - dest.x)).toBeLessThan(dest.r * 0.6);
    });
  }
});
