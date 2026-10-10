import { defaultParams } from '@darkroom/core';
import { describe, expect, it, vi } from 'vitest';

const renderSmall = vi.fn(() => new Uint8Array(4));
vi.mock('../state/engineHub', () => ({
  getEngine: () => ({ sync: () => {}, renderSmall }),
  requestRedraw: () => {},
}));
vi.mock('../state/develop', () => ({
  useDevelop: { getState: () => ({ source: { info: { width: 4, height: 3 } }, base: {} }) },
}));
vi.mock('../engine/Engine', () => ({ computeHistogram: () => ({ l: new Array(256).fill(0) }) }));
vi.mock('./background', () => ({ toJpeg: async () => new Uint8Array() }));

const { cancelPreviewRenders, renderParamsPixels } = await import('./renderPreview');

describe('renderPreview queue', () => {
  it('cancels only the given scope', async () => {
    const p = defaultParams();
    const a = renderParamsPixels(p, 8, { scope: 'a' });
    const b = renderParamsPixels(p, 8, { scope: 'b' });
    const d = renderParamsPixels(p, 8);
    const keep = renderParamsPixels(p, 8, { scope: 'a', cancellable: false });
    cancelPreviewRenders('a');
    const a2 = renderParamsPixels(p, 8, { scope: 'a' });
    expect(await a).toBeNull();
    expect(await b).not.toBeNull();
    expect(await d).not.toBeNull();
    expect(await keep).not.toBeNull();
    expect(await a2).not.toBeNull();
    cancelPreviewRenders();
    const d2 = renderParamsPixels(p, 8);
    expect(await d2).not.toBeNull();
  });

  it('default scope cancel leaves named scopes alone', async () => {
    const p = defaultParams();
    const d = renderParamsPixels(p, 8);
    const g = renderParamsPixels(p, 8, { scope: 'guided' });
    cancelPreviewRenders();
    expect(await d).toBeNull();
    expect(await g).not.toBeNull();
  });
});
