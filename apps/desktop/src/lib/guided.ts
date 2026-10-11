/**
 * Guided Edit: the model-facing protocol. Each round the model calls
 * `propose_options` with 2–3 alternative patches for one aspect of the photo;
 * the user picks one (or skips) and the choice comes back as the tool result,
 * with fresh settings and a fresh render. Pure TypeScript, no DOM.
 */
import Anthropic from '@anthropic-ai/sdk';
import { paramsEqual, pickSections, SECTIONS, type EditParams, type PartialParams, type SectionName } from '@darkroom/core';
import { applyPatch, isObj, PATCH_SPEC, SETTINGS_REFERENCE, toSchema, type Spec } from './ai';

export const GUIDED_TOOL_NAME = 'propose_options';
export const MAX_GUIDED_ROUNDS = 6;
const MAX_ITERATIONS = 4;

/** Guided rounds edit global settings only: masks are never part of an option. */
const GUIDED_PATCH_SPEC: Record<string, Spec> = Object.fromEntries(Object.entries(PATCH_SPEC).filter(([k]) => k !== 'masks'));

export const GUIDED_TOOL: Anthropic.Beta.BetaTool = {
  name: GUIDED_TOOL_NAME,
  description:
    'Propose 2–3 alternative adjustments for ONE aspect of the photo, or declare the guided edit finished. Call exactly once per reply.',
  input_schema: {
    type: 'object',
    properties: {
      assessment: {
        type: 'string',
        description: 'Round 1 only: 2–4 sentences on what you see (light, color cast, contrast, subject) and what needs work.',
      },
      aspect: { type: 'string', description: 'Short label for this round, e.g. "Exposure & white balance".' },
      options: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'At most 5 words, e.g. "Brighter, cooler".' },
            why: { type: 'string', description: '1–2 sentences: what changes and why it helps THIS photo, referencing what you see.' },
            patch: toSchema({ t: 'obj', d: 'Sparse settings patch with absolute values; only the fields you change.', fields: GUIDED_PATCH_SPEC }),
          },
          required: ['title', 'why', 'patch'],
          additionalProperties: false,
        },
      },
      done: {
        type: 'boolean',
        description: 'true when no further rounds would meaningfully improve the photo. May be combined with a final set of options.',
      },
      doneReason: { type: 'string', description: 'One sentence, when done is true.' },
    },
    required: ['aspect', 'options', 'done'],
    additionalProperties: false,
  },
};

export const GUIDED_SYSTEM_PROMPT = `You are the Guided Edit assistant inside Darkroom, a local, non-destructive photo editor modeled on Lightroom's Develop module. You improve the user's photo step by step, one aspect per round, by proposing alternatives the user chooses between.

HARD RULE: Every reply must consist of exactly one call to \`${GUIDED_TOOL_NAME}\` and nothing else. Never reply in prose. When nothing more is worth changing, call it with done:true and an empty options array.

Round structure:
- Suggested order: 1) exposure & white balance; 2) tone and contrast (highlights, shadows, whites, blacks, parametric tone curve); 3) color (vibrance, saturation, color mixer, color grading, or a black & white treatment when it suits the photo); 4) detail & effects (sharpening, noise reduction, vignette, grain).
- Skip aspects that already look right; merge or reorder aspects when the photo calls for it. Use at most 5 rounds, and set done:true as soon as further rounds would be marginal.
- In round 1, fill \`assessment\` with what you see before proposing.

Options:
- Propose 2–3 options per round (always at least 2 unless done). Each must be a clearly different direction (e.g. "airy and bright" vs "moody and dense"), not three magnitudes of the same move.
- Differences must be visible at thumbnail size (roughly 0.3 stop or 15 slider points apart, or more) but stay photographic, never extreme.
- \`patch\` uses absolute target values (not deltas) in the same shape as the current settings JSON, and holds only the fields of this round's aspect. Include values set in earlier rounds only when you intentionally revise them.
- Guided rounds change global settings only; do not patch masks.

Explanations (\`why\`): 1–2 sentences, concrete and specific to this image (e.g. "the sky clips at the top right", "skin tones lean green"), saying what the change does for the photo.

Context: the first message has a JPEG render of the photo, camera metadata, a histogram summary and the current settings as JSON. Each later tool result holds the user's choice (or that they skipped the round), the updated settings JSON and a fresh render of the photo as it looks now. Build on what the user chose.

${SETTINGS_REFERENCE}`;

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface ProposalOption {
  title: string;
  why: string;
  patch: Record<string, unknown>;
}

export interface Proposal {
  assessment?: string;
  aspect: string;
  options: ProposalOption[];
  done: boolean;
  doneReason?: string;
}

/** Shape check of the tool input. Trims strings, caps options at 3. */
export function validateProposal(input: unknown): Proposal | null {
  if (!isObj(input) || typeof input.aspect !== 'string' || !Array.isArray(input.options) || typeof input.done !== 'boolean') return null;
  const options: ProposalOption[] = [];
  for (const o of input.options) {
    if (!isObj(o) || typeof o.title !== 'string' || typeof o.why !== 'string' || !isObj(o.patch)) return null;
    options.push({ title: o.title.trim(), why: o.why.trim(), patch: o.patch });
  }
  const out: Proposal = { aspect: input.aspect.trim(), options: options.slice(0, 3), done: input.done };
  if (typeof input.assessment === 'string') out.assessment = input.assessment.trim();
  if (typeof input.doneReason === 'string') out.doneReason = input.doneReason.trim();
  return out;
}

export interface SanitizedOption extends ProposalOption {
  params: EditParams;
  dropped: string[];
}

/** Resolve each option to full params; drop no-ops, duplicates and untitled options. Order is kept. */
export function sanitizeOptions(p: Proposal, committed: EditParams, base: EditParams): SanitizedOption[] {
  const kept: SanitizedOption[] = [];
  for (const o of p.options) {
    if (!o.title) continue;
    const { masks, ...patch } = o.patch;
    const { params, dropped } = applyPatch(committed, base, patch);
    if (masks !== undefined) dropped.unshift('masks');
    if (paramsEqual(params, committed)) continue;
    if (kept.some((k) => paramsEqual(k.params, params))) continue;
    kept.push({ ...o, params, dropped });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Session -> reusable filter
// ---------------------------------------------------------------------------

const SECTION_NAMES = Object.keys(SECTIONS) as SectionName[];
const NEVER_IN_FILTER: readonly SectionName[] = ['masks', 'spots', 'crop', 'patches'];

/** Sections whose values differ between `a` and `b`, in SECTIONS order. */
export function diffSections(a: EditParams, b: EditParams): SectionName[] {
  return SECTION_NAMES.filter((s) => !paramsEqual(pickSections(a, [s]), pickSections(b, [s])));
}

export interface FilterBuildOpts {
  sections?: SectionName[];
  excludeWb?: boolean;
  excludeExposure?: boolean;
}

export function buildFilterFromSession(
  start: EditParams,
  end: EditParams,
  o: FilterBuildOpts = {},
): { params: PartialParams; sections: SectionName[] } {
  const excludeWb = o.excludeWb ?? true;
  const excludeExposure = o.excludeExposure ?? true;
  let sections = (o.sections ?? diffSections(start, end)).filter(
    (s) => !NEVER_IN_FILTER.includes(s) && !(excludeWb && s === 'whiteBalance'),
  );
  // Without exposure, basic tone only belongs in the filter if one of its other sliders changed.
  if (excludeExposure && sections.includes('basicTone') && SECTIONS.basicTone.every((k) => k === 'exposure' || paramsEqual(start[k], end[k]))) {
    sections = sections.filter((s) => s !== 'basicTone');
  }
  const params = pickSections(end, sections);
  if (excludeExposure) delete params.exposure;
  return { params, sections };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Choice = { kind: 'picked'; title: string } | { kind: 'skipped' };

const NEXT_ROUND = 'Propose the next round, or set done:true if nothing more is worth changing.';

export function choiceMessage(
  toolUseId: string,
  choice: Choice,
  settings: Record<string, unknown>,
  context: Anthropic.Beta.BetaContentBlockParam[],
): Anthropic.Beta.BetaMessageParam {
  const head = choice.kind === 'picked' ? `User chose option: ${choice.title}.` : 'User skipped this round (no change).';
  const images = context.filter((b): b is Anthropic.Beta.BetaImageBlockParam => b.type === 'image');
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: `${head}\nSettings now: ${JSON.stringify(settings)}` }, ...images, { type: 'text', text: NEXT_ROUND }],
      },
    ],
  };
}

export function firstUserMessage(context: Anthropic.Beta.BetaContentBlockParam[]): Anthropic.Beta.BetaMessageParam {
  return { role: 'user', content: [...context, { type: 'text', text: 'Start the guided edit: assess the photo, then propose round 1.' }] };
}

// ---------------------------------------------------------------------------
// One round
// ---------------------------------------------------------------------------

export interface GuidedRoundIO {
  client: Anthropic;
  model: string;
  /** Conversation so far, ending with a user turn. Appended to in place. */
  messages: Anthropic.Beta.BetaMessageParam[];
  signal: AbortSignal;
  /** A new model request starts (first call, after a nudge, after pause_turn, on retry). */
  onRequest?(retry: boolean): void;
}

export type RoundResult = { kind: 'proposal'; proposal: Proposal; toolUseId: string } | { kind: 'refused'; explanation: string | null };

/** Request one round of options. Unlike runTurn, stops at the first valid propose_options call (its result comes later, from the user). */
export async function runGuidedRound(io: GuidedRoundIO): Promise<RoundResult> {
  let retries = 0;
  let retrying = false;
  let nudged = false;
  let wrongTool = false;
  let invalid = false;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    io.onRequest?.(retrying);
    retrying = false;
    const stream = io.client.beta.messages.stream(
      {
        model: io.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: GUIDED_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [GUIDED_TOOL],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: io.messages,
      },
      { signal: io.signal },
    );

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

    if (message.stop_reason === 'refusal') return { kind: 'refused', explanation: message.stop_details?.explanation ?? null };
    if (message.stop_reason === 'pause_turn') {
      io.messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const tu = message.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (message.stop_reason === 'max_tokens' && tu) throw new Error('The reply was cut off before the options were ready. Try again.');
    io.messages.push({ role: 'assistant', content: message.content });

    if (!tu) {
      if (nudged) throw new Error('The assistant did not propose options. Try again.');
      nudged = true;
      io.messages.push({ role: 'user', content: `Reply only by calling ${GUIDED_TOOL_NAME} now.` });
      continue;
    }
    if (tu.name !== GUIDED_TOOL_NAME) {
      if (wrongTool) break;
      wrongTool = true;
      io.messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Unknown tool "${tu.name}". Use ${GUIDED_TOOL_NAME}.` }],
      });
      continue;
    }
    const proposal = validateProposal(tu.input);
    if (proposal) return { kind: 'proposal', proposal, toolUseId: tu.id };
    if (invalid) break;
    invalid = true;
    io.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input) }) }],
    });
  }
  throw new Error('The assistant took too many steps. Try again.');
}
