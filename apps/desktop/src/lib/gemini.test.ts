import { describe, expect, it } from 'vitest';
import {
  ASPECTS,
  buildPrompt,
  buildRequest,
  createGeminiClient,
  describeGeminiError,
  fitOutput,
  formatPrice,
  fromBase64,
  inputSize,
  parseImageResponse,
  planCrop,
  priceFor,
  snapAspect,
  upsampleFactor,
  type CropPlan,
} from './gemini';

const ids = ASPECTS.map((a) => a.id);
const info = { width: 6000, height: 4000 };

function expectValid(plan: CropPlan | null, W: number, H: number) {
  expect(plan).not.toBeNull();
  const p = plan!;
  const [x, y, w, h] = p.rect;
  expect(ids).toContain(p.ratio);
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(x + w).toBeLessThanOrEqual(1 + 1e-9);
  expect(y + h).toBeLessThanOrEqual(1 + 1e-9);
  expect(p.px[0]).toBeCloseTo(w * W, 6);
  expect(p.px[1]).toBeCloseTo(h * H, 6);
  return p;
}

const contains = (outer: number[], inner: number[]) => {
  expect(outer[0]).toBeLessThanOrEqual(inner[0] + 1e-9);
  expect(outer[1]).toBeLessThanOrEqual(inner[1] + 1e-9);
  expect(outer[0] + outer[2]).toBeGreaterThanOrEqual(inner[0] + inner[2] - 1e-9);
  expect(outer[1] + outer[3]).toBeGreaterThanOrEqual(inner[1] + inner[3] - 1e-9);
};

describe('pricing', () => {
  it('looks up prices and formats them', () => {
    expect(priceFor('gemini-3-pro-image', '4K')).toBe(0.24);
    expect(priceFor('nope', '1K')).toBeNull();
    expect(formatPrice(0.034)).toBe('$0.03');
    expect(formatPrice(0.113)).toBe('$0.11');
    expect(formatPrice(0.24)).toBe('$0.24');
    expect(formatPrice(0.004)).toBe('<$0.01');
  });
});

describe('snapAspect', () => {
  it('picks the nearest ratio in log space', () => {
    expect(snapAspect(100, 100).id).toBe('1:1');
    expect(snapAspect(150, 100).id).toBe('3:2');
    // 0.5: ln-distance to 9:16 is 0.118, to 2:3 is 0.288
    expect(snapAspect(1, 2).id).toBe('9:16');
    expect(snapAspect(230, 100).id).toBe('21:9');
  });
});

describe('planCrop', () => {
  it('worked example: centered selection on a 6000x4000 image', () => {
    const p = expectValid(planCrop({ minX: 0.4, minY: 0.4, maxX: 0.6, maxY: 0.6 }, info), 6000, 4000);
    expect(p.area[0]).toBeCloseTo(0.4);
    expect(p.area[2]).toBeCloseTo(0.2);
    // padding on every side
    expect(p.rect[0]).toBeLessThan(0.4);
    expect(p.rect[1]).toBeLessThan(0.4);
    expect(p.rect[0] + p.rect[2]).toBeGreaterThan(0.6);
    expect(p.rect[1] + p.rect[3]).toBeGreaterThan(0.6);
    contains(p.rect, p.area);
    const a = ASPECTS.find((x) => x.id === p.ratio)!;
    expect(Math.abs(p.px[1] - (p.px[0] * a.h) / a.w)).toBeLessThanOrEqual(1);
    // area is 1200x800 px; pad 300 each side → 1800x1400 → nearest 5:4 → 1800x1440
    expect(p.ratio).toBe('5:4');
    expect(p.px).toEqual([1800, 1440]);
  });

  it('shifts a corner selection inside the image', () => {
    const p = expectValid(planCrop({ minX: 0, minY: 0, maxX: 0.05, maxY: 0.05 }, info), 6000, 4000);
    expect(p.rect[0]).toBe(0);
    expect(p.rect[1]).toBe(0);
    contains(p.rect, p.area);
  });

  it('tiny selections reach minPx', () => {
    const p = expectValid(planCrop({ minX: 0.5, minY: 0.5, maxX: 0.501, maxY: 0.501 }, info), 6000, 4000);
    expect(Math.min(...p.px)).toBeGreaterThanOrEqual(512);
    const q = expectValid(planCrop({ minX: 0.5, minY: 0.5, maxX: 0.501, maxY: 0.501 }, info, { minPx: 1000 }), 6000, 4000);
    expect(Math.min(...q.px)).toBeGreaterThanOrEqual(1000);
  });

  it('bounds larger than the image give the whole image', () => {
    const p = expectValid(planCrop({ minX: -0.2, minY: -0.1, maxX: 1.3, maxY: 1.2 }, info), 6000, 4000);
    expect(p.rect).toEqual([0, 0, 1, 1]);
    expect(p.ratio).toBe('3:2');
    expect(p.px).toEqual([6000, 4000]);
  });

  it('falls back to the next ratio or the whole image when the nearest does not fit', () => {
    // Full-width strip on a 4:3 image: nearest is 21:9, which fits by growing the height.
    const strip = expectValid(planCrop({ minX: 0, minY: 0.45, maxX: 1, maxY: 0.55 }, { width: 4000, height: 3000 }), 4000, 3000);
    contains(strip.rect, strip.area);
    // Odd 1.9:1 image covered entirely: 16:9 grows height past the image, 21:9 grows width → whole image.
    const odd = expectValid(planCrop({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { width: 1900, height: 1000 }), 1900, 1000);
    expect(odd.rect).toEqual([0, 0, 1, 1]);
  });

  it('returns null for empty or invalid bounds', () => {
    expect(planCrop({ minX: 0.5, minY: 0.5, maxX: 0.5, maxY: 0.6 }, info)).toBeNull();
    expect(planCrop({ minX: 0.6, minY: 0.5, maxX: 0.4, maxY: 0.6 }, info)).toBeNull();
    expect(planCrop({ minX: Infinity, minY: -Infinity, maxX: -Infinity, maxY: -Infinity }, info)).toBeNull();
    expect(planCrop({ minX: NaN, minY: 0, maxX: 1, maxY: 1 }, info)).toBeNull();
  });
});

describe('output sizing', () => {
  it('fitOutput and upsampleFactor', () => {
    expect(fitOutput([3000, 2000], '1K')).toEqual([1024, 683]);
    expect(upsampleFactor([3000, 2000], '1K')).toBeCloseTo(2.93, 2);
    expect(fitOutput([800, 600], '2K')).toEqual([800, 600]);
    expect(upsampleFactor([800, 600], '2K')).toBe(1);
  });

  it('inputSize caps the long edge', () => {
    expect(inputSize([3000, 2000])).toEqual([1536, 1024]);
    expect(inputSize([1000, 3000], 1024)).toEqual([341, 1024]);
    expect(inputSize([800, 600])).toEqual([800, 600]);
  });
});

describe('request', () => {
  it('prompt mentions the red region and the user text', () => {
    const p = buildPrompt('add a sailboat');
    expect(p).toContain('red');
    expect(p).toContain('Request: add a sailboat');
  });

  it('builds the generateContent parameters', () => {
    const req = buildRequest({ model: 'm', prompt: 'P', plainPng: 'AAA', maskedPng: 'BBB', ratio: '4:3', size: '2K' });
    expect(req.model).toBe('m');
    expect(req.config).toEqual({ responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3', imageSize: '2K' } });
    const contents = req.contents as { role: string; parts: Record<string, any>[] }[];
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts[0]).toEqual({ text: 'P' });
    const inline = contents[0].parts.filter((p) => p.inlineData);
    expect(inline).toHaveLength(2);
    expect(inline.map((p) => p.inlineData.mimeType)).toEqual(['image/png', 'image/png']);
    expect(inline.map((p) => p.inlineData.data)).toEqual(['AAA', 'BBB']);
  });
});

describe('parseImageResponse', () => {
  it('reads the generateContent shape', () => {
    const res = {
      candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { data: 'IMG', mimeType: 'image/jpeg' } }] }, finishReason: 'STOP' }],
    };
    expect(parseImageResponse(res)).toEqual({ data: 'IMG', mimeType: 'image/jpeg' });
  });

  it('reads the Interactions shape', () => {
    const res = { outputs: [{ content: [{ type: 'text', text: 'x' }, { type: 'image', data: 'IMG2', mime_type: 'image/png' }] }] };
    expect(parseImageResponse(res)).toEqual({ data: 'IMG2', mimeType: 'image/png' });
  });

  it('reads a plain {data, mimeType}', () => {
    expect(parseImageResponse({ data: 'IMG3', mimeType: 'image/webp' })).toEqual({ data: 'IMG3', mimeType: 'image/webp' });
  });

  it('throws readable errors', () => {
    expect(() => parseImageResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow('The request was blocked (SAFETY).');
    const long = 'no. '.repeat(200);
    let msg = '';
    try {
      parseImageResponse({ candidates: [{ content: { parts: [{ text: `  ${long}` }] }, finishReason: 'STOP' }] });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.startsWith('The model replied with text instead of an image: no.')).toBe(true);
    expect(msg.length).toBeLessThanOrEqual('The model replied with text instead of an image: '.length + 300);
    expect(() => parseImageResponse({ candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }] })).toThrow(
      'Generation stopped: IMAGE_SAFETY',
    );
    expect(() => parseImageResponse({})).toThrow('The model returned no image.');
    expect(() => parseImageResponse(null)).toThrow('The model returned no image.');
    expect(() => parseImageResponse({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] })).toThrow(
      'The model returned no image.',
    );
  });
});

describe('describeGeminiError', () => {
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  it.each([
    [abort, 'Stopped.'],
    [new Error('got status: 400 API key not valid. Please pass a valid API key.'), 'The Google AI API key was rejected. Check it in Settings.'],
    [Object.assign(new Error('forbidden'), { status: 403 }), 'The Google AI API key was rejected. Check it in Settings.'],
    [new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), 'Rate limit or quota exceeded; try again shortly.'],
    [
      new Error('{"error":{"code":429,"message":"You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0","status":"RESOURCE_EXHAUSTED"}}'),
      /no image quota.*billing/,
    ],
    [
      new Error('got status: 404 . models/gemini-foo-9 is not found for API version v1beta'),
      'Model "gemini-foo-9" is not available for this key.',
    ],
    [new Error('NOT_FOUND'), 'The model is not available for this key.'],
    [new TypeError('Failed to fetch'), 'Could not reach generativelanguage.googleapis.com. Check your connection.'],
    [new Error('NetworkError when attempting to fetch resource.'), 'Could not reach generativelanguage.googleapis.com. Check your connection.'],
    [new Error('  something odd  '), 'something odd'],
    ['plain string', 'plain string'],
  ])('%s', (err, expected) => {
    if (expected instanceof RegExp) expect(describeGeminiError(err)).toMatch(expected);
    else expect(describeGeminiError(err)).toBe(expected);
  });

  it('trims long messages to 300 chars', () => {
    expect(describeGeminiError(new Error('z'.repeat(1000))).length).toBeLessThanOrEqual(300);
  });
});

describe('misc', () => {
  it('fromBase64 roundtrips with btoa', () => {
    const bytes = [0, 1, 2, 127, 128, 200, 255];
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(fromBase64(b64))).toEqual(bytes);
  });

  it('createGeminiClient returns a client', () => {
    const c = createGeminiClient('x');
    expect(typeof c).toBe('object');
    expect(typeof c.models.generateContent).toBe('function');
  });
});
