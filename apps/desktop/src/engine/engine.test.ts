import { cropToSource, defaultParams } from '@darkroom/core';
import { describe, expect, it } from 'vitest';
import { fileName } from '../lib/background';
import type { ImageRow } from '../ipc/types';
import { autoSource } from '../components/SpotOverlay';
import { computeHistogram, cropUvToSource, expandForSpots } from './Engine';
import { parsePreview, parseRegion } from './source';

const info = { width: 6000, height: 4000 };

describe('engine helpers', () => {
  it('cropUvToSource matches the core geometry', () => {
    const p = defaultParams();
    p.geometry = { ...p.geometry, rotate: 1, flipH: true, angle: 6, crop: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 } };
    for (const [u, v] of [[0, 0], [0.3, 0.8], [1, 1]]) {
      const a = cropUvToSource(p.geometry, info, u, v);
      const b = cropToSource(p.geometry, { w: info.width, h: info.height }, u, v);
      expect(a[0]).toBeCloseTo(b[0], 9);
      expect(a[1]).toBeCloseTo(b[1], 9);
    }
  });

  it('expands regions to include spot sources', () => {
    const p = defaultParams();
    p.spots = [{ id: 'a', mode: 'heal', x: 0.5, y: 0.5, sx: 0.9, sy: 0.1, r: 0.01, feather: 0.5, opacity: 1 }];
    const [x0, y0, x1, y1] = expandForSpots([0.4, 0.4, 0.6, 0.6], p, info);
    expect(x1).toBeGreaterThan(0.9);
    expect(y0).toBeLessThan(0.1);
    expect(x0).toBe(0.4);
    expect(y1).toBe(0.6);
    // spots elsewhere don't grow the box
    expect(expandForSpots([0, 0, 0.1, 0.1], p, info)).toEqual([0, 0, 0.1, 0.1]);
  });

  it('auto-picks a spot source inside the image', () => {
    const [sx, sy] = autoSource(0.99, 0.5, 0.02, info);
    expect(sx).toBeLessThan(0.99);
    expect(sy).toBeGreaterThanOrEqual(0);
  });

  it('parses preview and region wire formats', () => {
    const hdr = { photoId: 1, width: 4, height: 2, previewWidth: 2, previewHeight: 1, color: { isRaw: false, xyzToCam: [3.24, -1.54, -0.5, -0.97, 1.88, 0.04, 0.06, -0.2, 1.06], asShotMul: [1, 1, 1], space: 'srgb' } };
    const json = new TextEncoder().encode(JSON.stringify(hdr));
    const pad = (4 - ((4 + json.length) % 4)) % 4;
    const buf = new ArrayBuffer(4 + json.length + pad + 2 * 3 * 2);
    new DataView(buf).setUint32(0, json.length + pad, true);
    new Uint8Array(buf, 4, json.length).set(json);
    new Uint8Array(buf, 4 + json.length, pad).fill(32);
    new Uint16Array(buf, 4 + json.length + pad).set([65535, 0, 32768, 0, 65535, 0]);
    const src = parsePreview(buf);
    expect(src.info.previewWidth).toBe(2);
    expect(src.data[0]).toBe(1);
    expect(src.data[2]).toBeCloseTo(0.5, 4);
    const rb = new ArrayBuffer(8 + 6);
    new DataView(rb).setUint32(0, 1, true);
    new DataView(rb).setUint32(4, 1, true);
    new Uint16Array(rb, 8).set([0, 65535, 0]);
    const r = parseRegion(rb);
    expect([r.w, r.h, r.data[1]]).toEqual([1, 1, 1]);
  });

  it('computes histograms', () => {
    const px = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    const h = computeHistogram(px);
    expect(h.r[255]).toBe(1);
    expect(h.b[255]).toBe(1);
    expect(h.g[0]).toBe(2);
  });
});

describe('export file names', () => {
  const row = { filename: 'IMG_0042.CR3', capturedAt: '2024-06-01T10:00:00', rating: 4, copyName: null } as unknown as ImageRow;
  it('applies templates', () => {
    expect(fileName(row, '{name}', 1, 'jpg')).toBe('IMG_0042.jpg');
    expect(fileName(row, '{date}-{seq}-{rating}', 7, 'tif')).toBe('2024-06-01-007-4.tif');
    expect(fileName({ ...row, copyName: 'Copy 1' }, '{name}', 1, 'jpg')).toBe('IMG_0042-Copy1.jpg');
    expect(fileName(row, 'a/b:c', 1, 'jpg')).toBe('a-b-c.jpg');
  });
});
