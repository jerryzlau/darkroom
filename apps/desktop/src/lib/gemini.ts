/**
 * Generative Fill: the model-facing half. Pure TypeScript with no DOM access
 * so it runs (and is tested) in node.
 *
 * The user draws a selection; the caller computes its bounds, `planCrop`
 * picks a padded crop snapped to an aspect ratio the image model supports,
 * the caller renders that crop twice (plain, and with the selection tinted
 * red), and `generateImage` sends both with `buildPrompt` to a Nano Banana
 * (Gemini image) model. The returned image is composited back through the
 * mask by the caller.
 */
import { GoogleGenAI, type GenerateContentConfig } from '@google/genai';

/** Settings key for the Google AI API key (plain text in the catalog, like `SETTING_KEY` in ai.ts). */
export const GEMINI_KEY = 'geminiApiKey';
/** Settings key for the selected image model id. */
export const GEMINI_MODEL = 'geminiModel';
/** Model used when the setting is unset. */
export const DEFAULT_GEMINI_MODEL = 'gemini-nano-banana-2.1';

/** Output size tier of the image model. */
export type ImageSize = '1K' | '2K' | '4K';
/** All output size tiers, smallest first. */
export const IMAGE_SIZES: readonly ImageSize[] = ['1K', '2K', '4K'];
/** Nominal long edge of the model output per size. */
export const SIZE_PX: Record<ImageSize, number> = { '1K': 1024, '2K': 2048, '4K': 4096 };

/** An image model the user can pick. */
export interface GeminiModel {
  id: string;
  name: string;
  /** USD per output image */
  price: Record<ImageSize, number>;
}

/** Known image models with their per-image prices. */
export const GEMINI_MODELS: readonly GeminiModel[] = [
  { id: 'gemini-nano-banana-2.1', name: 'Nano Banana 2.1', price: { '1K': 0.034, '2K': 0.05, '4K': 0.113 } },
  { id: 'gemini-3-pro-image', name: 'Nano Banana Pro', price: { '1K': 0.134, '2K': 0.134, '4K': 0.24 } },
  { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2', price: { '1K': 0.045, '2K': 0.09, '4K': 0.151 } },
];

/** USD per output image for a model and size; null for unknown model ids. */
export function priceFor(modelId: string, size: ImageSize): number | null {
  const m = GEMINI_MODELS.find((x) => x.id === modelId);
  return m ? m.price[size] : null;
}

/** Format a USD amount: '$0.03', '$0.11'; '<$0.01' below half a cent. */
export function formatPrice(usd: number): string {
  if (!(usd >= 0.005)) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Crop planning
// ---------------------------------------------------------------------------

/** A supported output aspect ratio. */
export interface Aspect {
  /** e.g. '4:3' */
  id: string;
  w: number;
  h: number;
}

const aspect = (w: number, h: number): Aspect => ({ id: `${w}:${h}`, w, h });

/** Aspect ratios the image model accepts. */
export const ASPECTS: readonly Aspect[] = [
  aspect(1, 1),
  aspect(2, 3),
  aspect(3, 2),
  aspect(3, 4),
  aspect(4, 3),
  aspect(4, 5),
  aspect(5, 4),
  aspect(9, 16),
  aspect(16, 9),
  aspect(21, 9),
];

const logDist = (a: Aspect, ratio: number) => Math.abs(Math.log(ratio) - Math.log(a.w / a.h));

/** Supported aspects sorted by closeness to `ratio` (log space). */
function aspectsByCloseness(ratio: number): Aspect[] {
  return [...ASPECTS].sort((a, b) => logDist(a, ratio) - logDist(b, ratio));
}

/** Nearest supported aspect by |ln(ratio) - ln(w/h)|. */
export function snapAspect(w: number, h: number): Aspect {
  const r = w > 0 && h > 0 && Number.isFinite(w / h) ? w / h : 1;
  return aspectsByCloseness(r)[0];
}

/** [x, y, w, h] in source UV. */
export type Rect = [number, number, number, number];

/** The crop sent to the model for one fill. */
export interface CropPlan {
  /** padded crop snapped to `ratio`, source UV */
  rect: Rect;
  /** the selection bounds themselves, source UV */
  area: Rect;
  ratio: string;
  /** crop size in full-resolution pixels */
  px: [number, number];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Plan the crop sent to the model from selection bounds (source UV) and the image size.
 * pad: fraction of the bounds' larger side added on every side (default 0.25) so the model sees context.
 * minPx: minimum crop side in full-res px (default 512) so tiny selections still get a usable crop.
 * The crop is snapped to the nearest supported aspect by GROWING the short side, kept inside the image by
 * shifting, and if the image is too small for that ratio the next-nearest ratios are tried in order of
 * closeness; as a last resort the crop is the whole image with its own snapped ratio.
 * Returns null when bounds are empty/invalid.
 */
export function planCrop(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  info: { width: number; height: number },
  opts: { pad?: number; minPx?: number } = {},
): CropPlan | null {
  const W = info.width;
  const H = info.height;
  if (!(W >= 1 && H >= 1) || !Number.isFinite(W) || !Number.isFinite(H)) return null;
  const { minX, minY, maxX, maxY } = bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  const x0 = clamp(minX, 0, 1);
  const y0 = clamp(minY, 0, 1);
  const x1 = clamp(maxX, 0, 1);
  const y1 = clamp(maxY, 0, 1);
  if (!(x1 > x0 && y1 > y0)) return null;
  const area: Rect = [x0, y0, x1 - x0, y1 - y0];

  const pad = Math.max(0, opts.pad ?? 0.25);
  const minPx = Math.max(1, opts.minPx ?? 512);

  // Selection in px, padded, clamped to the image, then grown to the minimum side.
  const aw = area[2] * W;
  const ah = area[3] * H;
  const p = pad * Math.max(aw, ah);
  const bw = Math.max(Math.min(W, aw + 2 * p), Math.min(W, minPx));
  const bh = Math.max(Math.min(H, ah + 2 * p), Math.min(H, minPx));
  const cx = (x0 + area[2] / 2) * W;
  const cy = (y0 + area[3] / 2) * H;

  for (const a of aspectsByCloseness(bw / bh)) {
    const r = a.w / a.h;
    let cw = bw;
    let ch = bh;
    if (cw / ch < r) cw = ch * r;
    else ch = cw / r;
    if (cw > W + 1e-6 || ch > H + 1e-6) continue;
    // Round to whole pixels, keeping the aspect exact to within a pixel.
    let pw: number;
    let ph: number;
    if (r >= 1) {
      pw = Math.min(W, Math.round(cw));
      ph = Math.min(H, Math.max(1, Math.round(pw / r)));
    } else {
      ph = Math.min(H, Math.round(ch));
      pw = Math.min(W, Math.max(1, Math.round(ph * r)));
    }
    const px = clamp(cx - pw / 2, 0, W - pw);
    const py = clamp(cy - ph / 2, 0, H - ph);
    return { rect: [px / W, py / H, pw / W, ph / H], area, ratio: a.id, px: [pw, ph] };
  }

  return { rect: [0, 0, 1, 1], area, ratio: snapAspect(W, H).id, px: [Math.round(W), Math.round(H)] };
}

/** Scale `px` down so its long edge is at most `max`, aspect preserved; never scales up. */
function capLongEdge(px: [number, number], max: number): [number, number] {
  const [w, h] = px;
  const long = Math.max(w, h);
  if (long <= max) return [w, h];
  const s = max / long;
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** Pixel size the stored patch should have: the crop size, but never larger than the model output for `size` (no upsampling of model pixels). Aspect preserved. */
export function fitOutput(cropPx: [number, number], size: ImageSize): [number, number] {
  return capLongEdge(cropPx, SIZE_PX[size]);
}

/** Upsampling factor on export if the fill is stored at `fitOutput` size: cropPx long edge / stored long edge (>= 1). */
export function upsampleFactor(cropPx: [number, number], size: ImageSize): number {
  const out = fitOutput(cropPx, size);
  return Math.max(1, Math.max(cropPx[0], cropPx[1]) / Math.max(out[0], out[1]));
}

/** Pixel size of the reference images sent to the model: the crop, capped at `max` on the long edge (default 1536). */
export function inputSize(cropPx: [number, number], max = 1536): [number, number] {
  return capLongEdge(cropPx, max);
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

/** The instruction sent with the two reference images. */
export function buildPrompt(user: string): string {
  return [
    'You are editing a photograph.',
    'Image 1 is a crop of a photograph.',
    'Image 2 is the same crop with the editable region tinted red.',
    "Apply the request below ONLY inside the red-tinted region. Everything outside the red-tinted region must stay pixel-identical to image 1.",
    'Keep exactly the same framing: do not crop, zoom, stretch, rotate or shift the image. Do not add text, watermarks, logos or borders.',
    "New content must match the photo's perspective, lighting, color and grain, and must fit entirely inside the red-tinted region.",
    'Output the full edited image 1 at the same framing and size, with no red tint anywhere.',
    '',
    `Request: ${user.trim()}`,
  ].join('\n');
}

/** One Generative Fill request. */
export interface GenerateRequest {
  model: string;
  prompt: string;
  /** base64 PNGs */
  plainPng: string;
  maskedPng: string;
  ratio: string;
  size: ImageSize;
}

/** The generateContent parameters for a request (pure; tested). */
export function buildRequest(r: GenerateRequest): {
  model: string;
  contents: unknown;
  config: { responseModalities: string[]; imageConfig: { aspectRatio: string; imageSize: ImageSize } };
} {
  return {
    model: r.model,
    contents: [
      {
        role: 'user',
        parts: [
          { text: r.prompt },
          { inlineData: { mimeType: 'image/png', data: r.plainPng } },
          { inlineData: { mimeType: 'image/png', data: r.maskedPng } },
        ],
      },
    ],
    config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: r.ratio, imageSize: r.size } },
  };
}

/** An image returned by the model. */
export interface GeneratedImage {
  /** base64 */
  data: string;
  mimeType: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clip = (s: string, n = 300) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Extract the first image from a model response. Accepts the generateContent shape
 * (candidates[].content.parts[].inlineData), the Interactions shape (outputs[].content[] with
 * {type:'image', data, mime_type}), and a plain {data, mimeType}. Throws a readable Error otherwise:
 * promptFeedback.blockReason → 'The request was blocked (<reason>).'; a text-only reply → 'The model replied with text instead of an image: <text (trimmed, ≤300 chars)>';
 * finishReason other than STOP without an image → 'Generation stopped: <reason>'; empty → 'The model returned no image.'
 */
export function parseImageResponse(res: unknown): GeneratedImage {
  if (!isObj(res)) throw new Error('The model returned no image.');

  // Plain {data, mimeType}.
  const plain = str(res.data);
  if (plain && !('candidates' in res) && !('outputs' in res)) {
    return { data: plain, mimeType: str(res.mimeType) ?? str(res.mime_type) ?? 'image/png' };
  }

  const texts: string[] = [];
  let finish: string | undefined;

  // generateContent shape.
  for (const c of arr(res.candidates)) {
    if (!isObj(c)) continue;
    finish ??= str(c.finishReason);
    const content = isObj(c.content) ? c.content : undefined;
    for (const part of arr(content?.parts)) {
      if (!isObj(part)) continue;
      const inline = isObj(part.inlineData) ? part.inlineData : isObj(part.inline_data) ? part.inline_data : undefined;
      const data = str(inline?.data);
      if (data) return { data, mimeType: str(inline?.mimeType) ?? str(inline?.mime_type) ?? 'image/png' };
      if (typeof part.text === 'string' && !part.thought) texts.push(part.text);
    }
  }

  // Interactions shape: outputs[] items, either images themselves or with a content[] array.
  for (const o of arr(res.outputs)) {
    if (!isObj(o)) continue;
    for (const item of [o, ...arr(o.content)]) {
      if (!isObj(item)) continue;
      if (item.type === 'image') {
        const data = str(item.data);
        if (data) return { data, mimeType: str(item.mime_type) ?? str(item.mimeType) ?? 'image/png' };
      } else if (item.type === 'text' && typeof item.text === 'string') {
        texts.push(item.text);
      }
    }
  }

  const feedback = isObj(res.promptFeedback) ? res.promptFeedback : undefined;
  const block = str(feedback?.blockReason);
  if (block) throw new Error(`The request was blocked (${block}).`);
  const text = texts.join('\n').trim();
  if (text) throw new Error(`The model replied with text instead of an image: ${clip(text)}`);
  if (finish && finish !== 'STOP') throw new Error(`Generation stopped: ${finish}`);
  throw new Error('The model returned no image.');
}

/** A user-facing message for an error from `generateImage`. */
export function describeGeminiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  const status = isObj(err) && typeof err.status === 'number' ? err.status : isObj(err) && typeof err.code === 'number' ? err.code : undefined;
  const has = (re: RegExp) => re.test(msg);

  if (name === 'AbortError' || has(/\babort(ed)?\b/i)) return 'Stopped.';
  if (status === 401 || status === 403 || has(/API key|\b40[13]\b|PERMISSION_DENIED|API_KEY_INVALID/i)) {
    return 'The Google AI API key was rejected. Check it in Settings.';
  }
  if (status === 429 || has(/\b429\b|RESOURCE_EXHAUSTED|quota/i)) {
    return 'Rate limit or quota exceeded. Image output needs a paid key; try again shortly.';
  }
  if (status === 404 || has(/\b404\b|not found|NOT_FOUND/i)) {
    const id = /models\/([\w.-]+)/.exec(msg)?.[1];
    return id ? `Model "${id}" is not available for this key.` : 'The model is not available for this key.';
  }
  if (name === 'TypeError' || has(/Failed to fetch|NetworkError/i)) {
    return 'Could not reach generativelanguage.googleapis.com. Check your connection.';
  }
  return clip(msg);
}

/** A Google GenAI client for the user's key (called from the webview). */
export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

/** One generateContent call with abort support. */
export async function generateImage(client: GoogleGenAI, r: GenerateRequest, signal?: AbortSignal): Promise<GeneratedImage> {
  const req = buildRequest(r);
  const config: GenerateContentConfig = { ...req.config, abortSignal: signal };
  const res = await client.models.generateContent({
    model: req.model,
    contents: req.contents as Parameters<GoogleGenAI['models']['generateContent']>[0]['contents'],
    config,
  });
  return parseImageResponse(res);
}

/** base64 → bytes (no DOM; uses atob). */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
