/**
 * AI Edit: the model-facing half of the chat panel. Pure TypeScript with no
 * DOM access so it runs (and is tested) in node.
 *
 * The model edits a photo through one tool, `adjust_settings`, whose input is
 * a sparse deep partial of `EditParams`. Every patch (live streaming snapshots
 * and the final tool input alike) goes through `applyPatch`, which sanitizes
 * against an allowlist, deep-merges onto the committed params and runs
 * `normalizeParams`, so the renderer can always trust the result.
 *
 * Masks are edited by id (`patch.masks.<id>.adj` etc.); their geometry, kind,
 * name and id are never editable by the model.
 */
import Anthropic from '@anthropic-ai/sdk';
import { HSL_BANDS, normalizeParams, type EditParams } from '@darkroom/core';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const SETTING_KEY = 'anthropicApiKey';
export const SETTING_MODEL = 'aiModel';
export const TOOL_NAME = 'adjust_settings';
const MAX_ITERATIONS = 8;

export function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// ---------------------------------------------------------------------------
// Patch spec: one table drives the tool schema, the sanitizer and the prompt.
// Ranges match normalizeParams.
// ---------------------------------------------------------------------------

export type Spec =
  | { t: 'num'; min: number; max: number; int?: boolean; d: string }
  | { t: 'bool'; d: string }
  | { t: 'enum'; values: readonly string[]; d: string }
  | { t: 'bands'; min: number; max: number; d: string }
  | { t: 'obj'; fields: Record<string, Spec>; d?: string }
  /** An object keyed by the id of an existing array element (masks); keys in readOnly are ignored. */
  | { t: 'byId'; fields: Record<string, Spec>; readOnly: readonly string[]; d: string };

const n = (min: number, max: number, d: string, int = false): Spec => ({ t: 'num', min, max, d, int });
const s100 = (d: string) => n(-100, 100, d);
const u100 = (d: string) => n(0, 100, d);
const wheelSpec = (which: string): Spec => ({
  t: 'obj',
  d: `Color grading wheel for ${which}.`,
  fields: {
    h: n(0, 360, 'Hue in degrees (0 red, 30 orange, 60 yellow, 120 green, 180 cyan, 240 blue, 300 magenta).'),
    s: u100('Tint strength 0..100. 0 = no tint (hue has no effect).'),
    l: s100('Luminance shift for this range.'),
  },
});

const LOCAL_SPEC: Record<string, Spec> = {
  exposure: n(-4, 4, 'Local exposure in stops.'),
  contrast: s100('Local contrast.'),
  highlights: s100('Local highlights.'),
  shadows: s100('Local shadows.'),
  whites: s100('Local whites.'),
  blacks: s100('Local blacks.'),
  temp: s100('Relative temperature shift (positive = warmer, negative = cooler). Not Kelvin.'),
  tint: s100('Relative tint shift (positive = magenta, negative = green).'),
  saturation: s100('Local saturation.'),
  clarity: s100('Local clarity.'),
  dehaze: s100('Local dehaze.'),
  texture: s100('Local texture.'),
};

const MASK_ENTRY: Record<string, Spec> = {
  enabled: { t: 'bool', d: 'Whether the mask is applied.' },
  invert: { t: 'bool', d: 'Invert the mask (affect everything outside it).' },
  amount: u100('Overall strength of the mask 0..100.'),
  range: {
    t: 'obj',
    d: 'Range refinement: limit the mask to a luminance or color range inside its area.',
    fields: {
      mode: { t: 'enum', values: ['none', 'luminance', 'color'], d: "'none' = whole mask area; 'luminance' or 'color' narrows it." },
      lumMin: u100('Luminance range start 0..100 (luminance mode).'),
      lumMax: u100('Luminance range end 0..100 (luminance mode, >= lumMin).'),
      lumFeather: u100('Luminance range smoothness 0..100.'),
      hue: n(0, 360, 'Target hue in degrees (color mode).'),
      sat: n(0, 1, 'Target saturation 0..1 (color mode).'),
      amount: u100('Color range tolerance 0..100 (color mode).'),
    },
  },
  adj: { t: 'obj', d: 'Local adjustments applied inside the mask.', fields: LOCAL_SPEC },
};

export const PATCH_SPEC: Record<string, Spec> = {
  treatment: { t: 'enum', values: ['color', 'bw'], d: "'color' or 'bw' (black & white)." },
  wb: {
    t: 'obj',
    d: "White balance. 'asShot' uses the camera's value; any temp/tint change implies 'custom'.",
    fields: {
      mode: { t: 'enum', values: ['asShot', 'custom'], d: "'asShot' resets to the camera white balance." },
      temp: n(2000, 50000, 'Absolute color temperature in Kelvin of the scene light. Higher = warmer (more yellow) result.'),
      tint: n(-150, 150, 'Tint. Positive = more magenta, negative = more green.'),
    },
  },
  exposure: n(-5, 5, 'Exposure in stops.'),
  contrast: s100('Contrast.'),
  highlights: s100('Highlights recovery (negative darkens bright areas).'),
  shadows: s100('Shadows (positive lifts dark areas).'),
  whites: s100('White point.'),
  blacks: s100('Black point (negative deepens blacks).'),
  texture: s100('Texture (fine detail contrast).'),
  clarity: s100('Clarity (midtone local contrast).'),
  dehaze: s100('Dehaze (positive removes haze, negative adds it).'),
  vibrance: s100('Vibrance (saturation weighted toward muted colors).'),
  saturation: s100('Global saturation.'),
  toneCurve: {
    t: 'obj',
    fields: {
      region: {
        t: 'obj',
        d: 'Parametric tone curve regions.',
        fields: {
          highlights: s100('Parametric curve highlights.'),
          lights: s100('Parametric curve lights.'),
          darks: s100('Parametric curve darks.'),
          shadows: s100('Parametric curve shadows.'),
        },
      },
    },
  },
  hsl: {
    t: 'obj',
    d: 'Color mixer, per hue band.',
    fields: {
      hue: { t: 'bands', min: -100, max: 100, d: 'Hue shift per band.' },
      sat: { t: 'bands', min: -100, max: 100, d: 'Saturation per band.' },
      lum: { t: 'bands', min: -100, max: 100, d: 'Luminance per band.' },
    },
  },
  bwMix: { t: 'bands', min: -100, max: 100, d: 'B&W mix: brightness of each source color in the black & white conversion (only used when treatment is bw).' },
  grading: {
    t: 'obj',
    d: 'Color grading (split toning).',
    fields: {
      shadows: wheelSpec('shadows'),
      midtones: wheelSpec('midtones'),
      highlights: wheelSpec('highlights'),
      global: wheelSpec('the whole image'),
      blending: u100('Blending between ranges (default 50).'),
      balance: s100('Balance: negative favors shadows, positive favors highlights.'),
    },
  },
  detail: {
    t: 'obj',
    d: 'Sharpening and noise reduction.',
    fields: {
      sharpAmount: n(0, 150, 'Sharpening amount.'),
      sharpRadius: n(0.5, 3, 'Sharpening radius in pixels.'),
      sharpDetail: u100('Sharpening detail.'),
      sharpMasking: u100('Sharpening edge masking.'),
      nrLuma: u100('Luminance noise reduction.'),
      nrLumaDetail: u100('Luminance NR detail.'),
      nrColor: u100('Color noise reduction.'),
      nrColorDetail: u100('Color NR detail.'),
    },
  },
  lens: {
    t: 'obj',
    d: 'Manual lens corrections.',
    fields: {
      distortion: s100('Distortion correction (positive fixes barrel).'),
      vignette: s100('Lens vignetting correction (positive brightens corners).'),
      caRed: s100('Red/cyan chromatic aberration.'),
      caBlue: s100('Blue/yellow chromatic aberration.'),
    },
  },
  effects: {
    t: 'obj',
    d: 'Creative effects.',
    fields: {
      vignetteAmount: s100('Post-crop vignette (negative darkens edges).'),
      vignetteMidpoint: u100('Vignette midpoint (default 50).'),
      vignetteRoundness: s100('Vignette roundness.'),
      vignetteFeather: u100('Vignette feather (default 50).'),
      grainAmount: u100('Film grain amount.'),
      grainSize: u100('Grain size (default 25).'),
      grainRoughness: u100('Grain roughness (default 50).'),
    },
  },
  geometry: {
    t: 'obj',
    d: 'Crop and rotation.',
    fields: {
      rotate: n(0, 3, 'Number of 90° clockwise rotations.', true),
      flipH: { t: 'bool', d: 'Flip horizontally.' },
      flipV: { t: 'bool', d: 'Flip vertically.' },
      angle: n(-45, 45, 'Straighten angle in degrees.'),
      crop: {
        t: 'obj',
        d: 'Crop rectangle normalized to the rotated frame (0..1). x+w and y+h must be <= 1.',
        fields: {
          x: n(0, 1, 'Left edge.'),
          y: n(0, 1, 'Top edge.'),
          w: n(0.01, 1, 'Width.'),
          h: n(0.01, 1, 'Height.'),
        },
      },
    },
  },
  masks: {
    t: 'byId',
    fields: MASK_ENTRY,
    readOnly: ['id', 'name', 'kind'],
    d: 'Existing masks keyed by id (see "masks" in the current settings). Include only masks and fields you change. Masks cannot be created, reshaped or renamed.',
  },
};

export function toSchema(spec: Spec): Record<string, unknown> {
  switch (spec.t) {
    case 'num':
      return { type: spec.int ? 'integer' : 'number', minimum: spec.min, maximum: spec.max, description: spec.d };
    case 'bool':
      return { type: 'boolean', description: spec.d };
    case 'enum':
      return { type: 'string', enum: [...spec.values], description: spec.d };
    case 'bands': {
      const properties: Record<string, unknown> = {};
      for (const b of HSL_BANDS) properties[b] = { type: 'number', minimum: spec.min, maximum: spec.max };
      return { type: 'object', description: `${spec.d} Keys are band names; include only bands you change.`, properties, additionalProperties: false };
    }
    case 'obj': {
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(spec.fields)) properties[k] = toSchema(v);
      return { type: 'object', ...(spec.d ? { description: spec.d } : {}), properties, additionalProperties: false };
    }
    case 'byId':
      return { type: 'object', description: spec.d, additionalProperties: toSchema({ t: 'obj', fields: spec.fields }) };
  }
}

export const ADJUST_TOOL: Anthropic.Beta.BetaTool = {
  name: TOOL_NAME,
  description:
    'Apply develop settings to the photo. `patch` is a sparse object containing ONLY the fields you change, with absolute target values ' +
    '(not deltas). Omitted fields keep their current values. The result is applied immediately as one undoable history step.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      patch: toSchema({ t: 'obj', d: 'Sparse settings patch.', fields: PATCH_SPEC }),
      summary: { type: 'string', description: 'A short label for the history panel, e.g. "Warmer, lifted shadows".' },
    },
    required: ['patch', 'summary'],
  },
};

// ---------------------------------------------------------------------------
// Sanitize / merge / apply
// ---------------------------------------------------------------------------

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function sanitizeNode(spec: Record<string, Spec>, input: Record<string, unknown>, current: unknown, path: string, dropped: string[]) {
  const out: Record<string, unknown> = {};
  const cur = isObj(current) ? current : {};
  for (const [k, v] of Object.entries(input)) {
    const p = path ? `${path}.${k}` : k;
    const sp = spec[k];
    if (!sp) {
      dropped.push(p);
      continue;
    }
    switch (sp.t) {
      case 'num':
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = sp.int ? Math.round(v) : v;
        else dropped.push(p);
        break;
      case 'bool':
        if (typeof v === 'boolean') out[k] = v;
        else dropped.push(p);
        break;
      case 'enum':
        if (typeof v === 'string' && sp.values.includes(v)) out[k] = v;
        else dropped.push(p);
        break;
      case 'bands': {
        if (!isObj(v)) {
          dropped.push(p);
          break;
        }
        const base = Array.isArray(cur[k]) ? [...(cur[k] as number[])] : HSL_BANDS.map(() => 0);
        let any = false;
        for (const [band, bv] of Object.entries(v)) {
          const i = (HSL_BANDS as readonly string[]).indexOf(band);
          if (i < 0 || typeof bv !== 'number' || !Number.isFinite(bv)) {
            dropped.push(`${p}.${band}`);
            continue;
          }
          base[i] = bv;
          any = true;
        }
        if (any) out[k] = base;
        break;
      }
      case 'obj': {
        if (!isObj(v)) {
          dropped.push(p);
          break;
        }
        const sub = sanitizeNode(sp.fields, v, cur[k], p, dropped);
        if (Object.keys(sub).length) out[k] = sub;
        break;
      }
      case 'byId': {
        if (!isObj(v)) {
          dropped.push(p);
          break;
        }
        const list = Array.isArray(cur[k]) ? (cur[k] as unknown[]) : [];
        const byId: Record<string, unknown> = {};
        for (const [id, body] of Object.entries(v)) {
          const ip = `${p}.${id}`;
          const el = list.find((x) => isObj(x) && x.id === id);
          if (!el || !isObj(body)) {
            dropped.push(ip);
            continue;
          }
          const editable = Object.fromEntries(Object.entries(body).filter(([bk]) => !sp.readOnly.includes(bk)));
          const sub = sanitizeNode(sp.fields, editable, el, ip, dropped);
          if (Object.keys(sub).length) byId[id] = sub;
        }
        if (Object.keys(byId).length) out[k] = byId;
        break;
      }
    }
  }
  return out;
}

/**
 * Keep only known fields with valid values. Band objects become full 8-element
 * arrays (taken from `current`). Out-of-range numbers are kept; normalizeParams clamps.
 */
export function sanitizePatch(input: unknown, current: EditParams): { partial: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  if (!isObj(input)) return { partial: {}, dropped };
  const partial = sanitizeNode(PATCH_SPEC, input, current, '', dropped);
  const wb = partial.wb as Record<string, unknown> | undefined;
  if (wb && wb.mode === undefined && (wb.temp !== undefined || wb.tint !== undefined)) wb.mode = 'custom';
  return { partial, dropped };
}

/** Recursively merge `src` into `target` in place and return it. Arrays and primitives replace wholesale. */
function deepMergeInto<T extends Record<string, unknown>>(target: T, src: Record<string, unknown>): T {
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v) && isObj(t[k])) deepMergeInto(t[k] as Record<string, unknown>, v);
    else t[k] = structuredClone(v);
  }
  return target;
}

/**
 * Recursive merge onto a clone of `base`. Arrays and primitives replace wholesale,
 * so this must not see `masks` (an object keyed by id); applyPatch splits it out.
 */
export function deepMergeParams(base: EditParams, partial: Record<string, unknown>): EditParams {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  return deepMergeInto(out, partial) as unknown as EditParams;
}

/** Sanitize + merge onto `committed` + normalize. Used for live previews and the final apply. */
export function applyPatch(committed: EditParams, base: EditParams, patch: unknown): { params: EditParams; dropped: string[] } {
  const { partial, dropped } = sanitizePatch(patch, committed);
  const { masks, ...rest } = partial;
  const merged = deepMergeParams(committed, rest);
  if (isObj(masks)) {
    merged.masks = merged.masks.map((m) => {
      const mp = masks[m.id];
      return isObj(mp) ? (deepMergeInto(structuredClone(m) as unknown as Record<string, unknown>, mp) as unknown as typeof m) : m;
    });
  }
  return { params: normalizeParams(merged, base), dropped };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const bandsObj = (a: number[]) => Object.fromEntries(HSL_BANDS.map((b, i) => [b, r3(a[i] ?? 0)]));

/** The editable settings in the same shape the tool accepts (for context and tool results). */
export function compactParams(p: EditParams): Record<string, unknown> {
  const g = p.geometry;
  return {
    treatment: p.treatment,
    wb: { mode: p.wb.mode, temp: Math.round(p.wb.temp), tint: r3(p.wb.tint) },
    exposure: r3(p.exposure),
    contrast: r3(p.contrast),
    highlights: r3(p.highlights),
    shadows: r3(p.shadows),
    whites: r3(p.whites),
    blacks: r3(p.blacks),
    texture: r3(p.texture),
    clarity: r3(p.clarity),
    dehaze: r3(p.dehaze),
    vibrance: r3(p.vibrance),
    saturation: r3(p.saturation),
    toneCurve: { region: { ...p.toneCurve.region } },
    hsl: { hue: bandsObj(p.hsl.hue), sat: bandsObj(p.hsl.sat), lum: bandsObj(p.hsl.lum) },
    bwMix: bandsObj(p.bwMix),
    grading: structuredClone(p.grading),
    detail: { ...p.detail },
    lens: { ...p.lens },
    effects: { ...p.effects },
    geometry: {
      rotate: g.rotate,
      flipH: g.flipH,
      flipV: g.flipV,
      angle: r3(g.angle),
      crop: { x: r3(g.crop.x), y: r3(g.crop.y), w: r3(g.crop.w), h: r3(g.crop.h) },
    },
    masks: Object.fromEntries(
      p.masks.map((m) => [
        m.id,
        {
          name: m.name,
          kind: m.kind,
          enabled: m.enabled,
          invert: m.invert,
          amount: r3(m.amount),
          range: { ...m.range },
          adj: Object.fromEntries(Object.entries(m.adj).map(([k, v]) => [k, r3(v)])),
        },
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// System prompt (stable; cached)
// ---------------------------------------------------------------------------

export const SETTINGS_REFERENCE = `Settings and ranges:
- exposure: -5..5 stops. contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, vibrance, saturation: -100..100.
- wb: mode asShot|custom, temp 2000..50000 K, tint -150..150 (positive = magenta).
- treatment: color|bw. bwMix bands -100..100.
- toneCurve.region: highlights, lights, darks, shadows -100..100.
- hsl.hue/sat/lum bands: -100..100.
- grading.shadows/midtones/highlights/global: h 0..360 degrees, s 0..100, l -100..100; grading.blending 0..100, grading.balance -100..100.
- detail: sharpAmount 0..150, sharpRadius 0.5..3, sharpDetail, sharpMasking, nrLuma, nrLumaDetail, nrColor, nrColorDetail 0..100.
- lens: distortion, vignette, caRed, caBlue -100..100.
- effects: vignetteAmount -100..100 (negative darkens edges), vignetteMidpoint 0..100, vignetteRoundness -100..100, vignetteFeather 0..100, grainAmount, grainSize, grainRoughness 0..100.
- geometry: rotate 0..3 (90° clockwise steps), flipH, flipV, angle -45..45 degrees, crop {x,y,w,h} normalized 0..1.
- masks.<id>: enabled, invert, amount 0..100; range {mode none|luminance|color, lumMin, lumMax, lumFeather 0..100, hue 0..360, sat 0..1, amount 0..100}; adj {exposure -4..4 stops; contrast, highlights, shadows, whites, blacks, temp, tint, saturation, clarity, dehaze, texture -100..100}.

Bands and white balance:
- Color mixer (hsl.hue/sat/lum) and bwMix take objects keyed by band: red, orange, yellow, green, aqua, blue, purple, magenta. Include only bands you change.
- White balance: wb.temp is the Kelvin of the light being corrected for, so raising it makes the photo warmer. Setting temp or tint switches wb to custom; {"mode":"asShot"} restores the camera value.

Things you cannot do: creating or reshaping masks, spot removal/retouching, point tone curves, adding or removing objects, generative edits. If a request needs one of these, say so briefly and offer the closest adjustment you can make.`;

export const SYSTEM_PROMPT = `You are the AI Edit assistant inside Darkroom, a local, non-destructive photo editor modeled on Lightroom's Develop module. The user describes how they want their photo to look and you change its develop settings.

Each user message includes a JPEG of the photo as currently rendered, the current settings as JSON, and camera metadata, followed by the request.

How to edit:
- For ANY change to the photo, call the \`${TOOL_NAME}\` tool. Make one call per response that contains every change for the request.
- \`patch\` holds only the fields you change, with absolute target values (not deltas), in the same shape as the current settings JSON. Omitted fields keep their current values.
- Prefer moderate, photographic adjustments. Small requests ("a bit", "slightly") mean small changes: roughly 0.2-0.5 stops of exposure or 10-25 slider points.
- Look at the image: judge exposure, color casts and contrast from the rendered JPEG, not only the numbers.

Masks and the selection (local adjustments):
- \`masks\` in the current settings is an object keyed by mask id. To edit a mask, patch \`masks.<id>\` with only the fields you change, e.g. {"masks":{"<id>":{"adj":{"exposure":0.5}}}}. Use ids exactly as given; unknown ids are ignored.
- The context may name an ACTIVE mask, which is "the selection". Requests about "the selected area", "the selection", "this part", "here" or "there" mean: change only \`masks.<activeId>.adj\` (plus its amount or range if useful) and leave the global settings alone unless the user also asks for a global change.
- When a second image is attached, it shows the photo with the active selection tinted red, so you can see what it covers. Judge the look from the first image.
- If there is no active mask and the request is clearly about one area, use an existing mask whose name or coverage fits and say which one; otherwise ask the user to draw a selection with the Select tool (S) first.
- Local adj values are offsets on top of the global settings: temp and tint are relative shifts (-100..100, positive temp = warmer, positive tint = more magenta), not Kelvin. There is no local color mixer (HSL) or color grading.
- range refines a mask: mode 'luminance' keeps only pixels between lumMin and lumMax (0 = black, 100 = white, lumFeather softens the edges); mode 'color' keeps pixels near hue/sat within the amount tolerance; 'none' uses the whole mask.
- You cannot create, delete, reshape, move or rename masks; only the user can draw them.

${SETTINGS_REFERENCE}

Replies: after the tool result, answer in 1-2 short sentences describing what you changed. If the request is a question rather than an edit, answer it briefly without calling the tool.
Latency-sensitive; begin your visible answer immediately.`;

/** A short, user-facing description of an API or loop error. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return '(stopped)';
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid API key. Check Settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your connection.';
  if (err instanceof Anthropic.APIError) return `API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Conversation loop
// ---------------------------------------------------------------------------

export interface ToolInput {
  patch: Record<string, unknown>;
  summary: string;
}

export interface TurnIO {
  client: Anthropic;
  model: string;
  /** Conversation so far, ending with the new user turn. Appended to in place. */
  messages: Anthropic.Beta.BetaMessageParam[];
  signal: AbortSignal;
  /** A new model request starts (first call, after tool results, after pause_turn, on retry). */
  onRequest(retry: boolean): void;
  onText(delta: string): void;
  onToolStart(name: string): void;
  /** Partial `patch` from the streaming tool input (may be undefined or incomplete). */
  onLivePatch(patch: unknown): void;
  onRefusal(explanation: string | null): void;
  /** Apply a validated tool call. Returns the tool_result content. */
  runTool(input: ToolInput): string;
}

export function validateToolInput(input: unknown): ToolInput | null {
  if (!isObj(input) || !isObj(input.patch) || typeof input.summary !== 'string') return null;
  return { patch: input.patch, summary: input.summary };
}

/** Run one user turn to completion: stream, apply tool calls, loop until the model stops calling tools. */
export async function runTurn(io: TurnIO): Promise<'done' | 'refused'> {
  let retries = 0;
  let retrying = false;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    io.onRequest(retrying);
    retrying = false;
    const stream = io.client.beta.messages.stream(
      {
        model: io.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [ADJUST_TOOL],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: io.messages,
      },
      { signal: io.signal },
    );
    stream.on('text', (delta) => io.onText(delta));
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') io.onToolStart(ev.content_block.name);
    });
    stream.on('inputJson', (_partial, snapshot) => {
      io.onLivePatch(isObj(snapshot) ? snapshot.patch : undefined);
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      // Unparseable tool JSON surfaces as a plain AnthropicError: re-issue the request.
      if (err instanceof Anthropic.APIError || io.signal.aborted || retries++ >= 2) throw err;
      retrying = true;
      iter--;
      continue;
    }

    if (message.stop_reason === 'refusal') {
      io.onRefusal(message.stop_details?.explanation ?? null);
      return 'refused';
    }
    if (message.stop_reason === 'pause_turn') {
      io.messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (message.stop_reason === 'max_tokens' && toolUses.length) {
      throw new Error('The reply was cut off before the adjustment finished. Try a shorter or simpler request.');
    }
    io.messages.push({ role: 'assistant', content: message.content });
    if (!toolUses.length) return 'done';

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((tu) => {
      if (tu.name !== TOOL_NAME) {
        return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Unknown tool "${tu.name}". Use ${TOOL_NAME}.` };
      }
      const input = validateToolInput(tu.input);
      if (!input) {
        return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input) }) };
      }
      try {
        return { type: 'tool_result', tool_use_id: tu.id, content: io.runTool(input) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Could not apply settings: ${e instanceof Error ? e.message : String(e)}` };
      }
    });
    io.messages.push({ role: 'user', content: results });
  }
  throw new Error('The assistant took too many steps. Try rephrasing the request.');
}
