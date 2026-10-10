import type Anthropic from '@anthropic-ai/sdk';
import { defaultParams, newMask } from '@darkroom/core';
import { describe, expect, it } from 'vitest';
import { applyPatch } from './ai';
import {
  buildFilterFromSession,
  choiceMessage,
  diffSections,
  firstUserMessage,
  GUIDED_SYSTEM_PROMPT,
  GUIDED_TOOL,
  runGuidedRound,
  sanitizeOptions,
  validateProposal,
  type Proposal,
} from './guided';

const base = defaultParams({ isRaw: true, asShotTemp: 5200, asShotTint: 8 });

type Obj = Record<string, unknown>;
const props = (s: unknown) => (s as { properties: Obj }).properties;

describe('guided tool', () => {
  it('schema shape', () => {
    const schema = GUIDED_TOOL.input_schema;
    expect(schema.required).toEqual(expect.arrayContaining(['aspect', 'options', 'done']));
    const options = props(schema).options as { maxItems: number; items: unknown };
    expect(options.maxItems).toBe(3);
    const patch = props(options.items).patch;
    const keys = Object.keys(props(patch));
    expect(keys).toContain('exposure');
    expect(keys).not.toContain('masks');
    expect(keys).not.toContain('spots');
    expect(keys).not.toContain('version');
    expect(GUIDED_TOOL.strict).toBeUndefined();
    expect(GUIDED_TOOL.eager_input_streaming).toBeUndefined();
    expect(GUIDED_TOOL.name).toBe('propose_options');
    expect(GUIDED_SYSTEM_PROMPT).toContain('propose_options');
    expect(GUIDED_SYSTEM_PROMPT).toContain('Settings and ranges:');
  });
});

const opt = (title: string, patch: Obj) => ({ title, why: 'because', patch });

describe('validateProposal', () => {
  it('rejects bad shapes', () => {
    expect(validateProposal('x')).toBeNull();
    expect(validateProposal(null)).toBeNull();
    expect(validateProposal({ options: [], done: false })).toBeNull();
    expect(validateProposal({ aspect: 'a', options: {}, done: false })).toBeNull();
    expect(validateProposal({ aspect: 'a', options: [{ title: 't', why: 'w' }], done: false })).toBeNull();
    expect(validateProposal({ aspect: 'a', options: [] })).toBeNull();
  });

  it('trims, caps and preserves optional fields', () => {
    const p = validateProposal({
      assessment: '  Dark and warm. ',
      aspect: ' Exposure ',
      options: [opt(' A ', {}), opt('B', {}), opt('C', {}), opt('D', {})],
      done: true,
      doneReason: ' enough ',
    });
    expect(p).not.toBeNull();
    expect(p!.options).toHaveLength(3);
    expect(p!.options[0].title).toBe('A');
    expect(p!.aspect).toBe('Exposure');
    expect(p!.assessment).toBe('Dark and warm.');
    expect(p!.done).toBe(true);
    expect(p!.doneReason).toBe('enough');
  });
});

describe('sanitizeOptions', () => {
  it('drops no-ops, duplicates and empty titles; keeps order; reports dropped', () => {
    const p: Proposal = {
      aspect: 'Exposure',
      done: false,
      options: [
        opt('Noop', {}),
        opt('Bright', { exposure: 0.7, foo: 1 }),
        opt('Dark', { exposure: -0.5 }),
        opt('Bright again', { exposure: 0.7 }),
        opt('', { exposure: 1.2 }),
      ],
    };
    const out = sanitizeOptions(p, base, base);
    expect(out.map((o) => o.title)).toEqual(['Bright', 'Dark']);
    expect(out[0].params.exposure).toBe(0.7);
    expect(out[0].dropped).toEqual(['foo']);
    expect(out[1].dropped).toEqual([]);
  });

  it('never applies mask patches', () => {
    const committed = structuredClone(base);
    const m = newMask('radial', 0);
    m.id = 'm';
    committed.masks = [m];
    const out = sanitizeOptions({ aspect: 'x', done: false, options: [opt('A', { exposure: 1, masks: { m: { amount: 10 } } })] }, committed, base);
    expect(out).toHaveLength(1);
    expect(out[0].params.masks).toEqual(committed.masks);
    expect(out[0].dropped).toContain('masks');
  });
});

describe('diffSections / buildFilterFromSession', () => {
  it('diffSections', () => {
    expect(diffSections(base, applyPatch(base, base, { exposure: 0.5 }).params)).toEqual(['basicTone']);
    expect(diffSections(base, applyPatch(base, base, { hsl: { sat: { blue: 10 } }, wb: { temp: 6000 } }).params)).toEqual([
      'whiteBalance',
      'colorMixer',
    ]);
  });

  const end = applyPatch(base, base, { wb: { mode: 'custom', temp: 6100 }, exposure: 0.4, contrast: 20, hsl: { sat: { blue: -30 } } }).params;

  it('defaults exclude wb and exposure', () => {
    const f = buildFilterFromSession(base, end);
    expect(f.sections).toEqual(['basicTone', 'colorMixer']);
    expect(f.params.contrast).toBe(20);
    expect(f.params.hsl).toEqual(end.hsl);
    expect(f.params).not.toHaveProperty('exposure');
    expect(f.params).not.toHaveProperty('wb');
  });

  it('options include exposure / wb', () => {
    expect(buildFilterFromSession(base, end, { excludeExposure: false }).params.exposure).toBe(0.4);
    const w = buildFilterFromSession(base, end, { excludeWb: false });
    expect(w.sections).toEqual(['whiteBalance', 'basicTone', 'colorMixer']);
    expect(w.params.wb).toEqual(end.wb);
  });

  it('exposure-only session gives an empty filter', () => {
    const f = buildFilterFromSession(base, applyPatch(base, base, { exposure: 1 }).params);
    expect(f.sections).toEqual([]);
    expect(f.params).toEqual({});
  });

  it('never includes masks, spots or geometry', () => {
    const e = applyPatch(base, base, { geometry: { angle: 3 }, vibrance: 10 }).params;
    const m = newMask('radial', 0);
    e.masks = [m];
    const f = buildFilterFromSession(base, e);
    expect(f.sections).toEqual(['presence']);
    expect(f.params).not.toHaveProperty('geometry');
    expect(f.params).not.toHaveProperty('masks');
    const forced = buildFilterFromSession(base, e, { sections: ['crop', 'masks', 'spots', 'presence'] });
    expect(forced.sections).toEqual(['presence']);
  });
});

const image: Anthropic.Beta.BetaContentBlockParam = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } };
const ctx: Anthropic.Beta.BetaContentBlockParam[] = [{ type: 'text', text: 'metadata' }, image];

describe('messages', () => {
  it('choiceMessage', () => {
    const picked = choiceMessage('tu_1', { kind: 'picked', title: 'Brighter, cooler' }, { exposure: 0.5 }, ctx);
    expect(picked.role).toBe('user');
    const blocks = picked.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('tu_1');
    const content = blocks[0].content as { type: string; text?: string }[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(content[0].text).toContain('Brighter, cooler');
    expect(content[0].text).toContain('"exposure":0.5');
    expect(content[2].text).toContain('Propose the next round');
    const skipped = choiceMessage('tu_2', { kind: 'skipped' }, {}, ctx);
    const sc = (skipped.content as Anthropic.Beta.BetaToolResultBlockParam[])[0].content as { text?: string }[];
    expect(sc[0].text).toContain('skipped');
  });

  it('firstUserMessage', () => {
    const m = firstUserMessage(ctx);
    const c = m.content as { type: string; text?: string }[];
    expect(c.slice(0, 2)).toEqual(ctx);
    expect(c[c.length - 1]).toEqual({ type: 'text', text: 'Start the guided edit: assess the photo, then propose round 1.' });
  });
});

// ---------------------------------------------------------------------------
// runGuidedRound with a fake client
// ---------------------------------------------------------------------------

function fakeClient(replies: Partial<Anthropic.Beta.BetaMessage>[]) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        stream: (body: { messages: unknown[] }) => {
          calls.push(structuredClone(body));
          const msg = replies.shift();
          if (!msg) throw new Error('no more replies');
          return { finalMessage: async () => msg };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const proposalInput = { aspect: 'Exposure', options: [opt('A', { exposure: 0.5 }), opt('B', { exposure: -0.5 })], done: false };
const toolReply = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_9', name: 'propose_options', input: proposalInput }] } as unknown as Partial<Anthropic.Beta.BetaMessage>;
const textReply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here are my thoughts' }] } as unknown as Partial<Anthropic.Beta.BetaMessage>;

describe('runGuidedRound', () => {
  const io = (client: Anthropic, messages: Anthropic.Beta.BetaMessageParam[]) => ({
    client,
    model: 'claude-opus-5-5',
    messages,
    signal: new AbortController().signal,
  });

  it('returns a proposal and pushes the assistant turn', async () => {
    const { client, calls } = fakeClient([toolReply]);
    const messages: Anthropic.Beta.BetaMessageParam[] = [firstUserMessage(ctx)];
    const r = await runGuidedRound(io(client, messages));
    expect(r).toEqual({ kind: 'proposal', proposal: validateProposal(proposalInput), toolUseId: 'tu_9' });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'assistant', content: toolReply.content });
    const body = calls[0] as Obj;
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  it('nudges after a text-only reply', async () => {
    const { client, calls } = fakeClient([textReply, toolReply]);
    const messages: Anthropic.Beta.BetaMessageParam[] = [firstUserMessage(ctx)];
    const requests: boolean[] = [];
    const r = await runGuidedRound({ ...io(client, messages), onRequest: (retry) => requests.push(retry) });
    expect(r.kind).toBe('proposal');
    expect(calls).toHaveLength(2);
    expect(requests).toEqual([false, false]);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2].content).toBe('Reply only by calling propose_options now.');
  });

  it('throws after two text-only replies', async () => {
    const { client } = fakeClient([textReply, textReply]);
    await expect(runGuidedRound(io(client, [firstUserMessage(ctx)]))).rejects.toThrow('did not propose options');
  });

  it('refusal returns refused without pushing', async () => {
    const { client } = fakeClient([
      { stop_reason: 'refusal', content: [], stop_details: { explanation: 'nope' } } as unknown as Partial<Anthropic.Beta.BetaMessage>,
    ]);
    const messages: Anthropic.Beta.BetaMessageParam[] = [firstUserMessage(ctx)];
    const r = await runGuidedRound(io(client, messages));
    expect(r).toEqual({ kind: 'refused', explanation: 'nope' });
    expect(messages).toHaveLength(1);
  });

  it('returns invalid input as an error tool_result and retries once', async () => {
    const bad = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_bad', name: 'propose_options', input: { aspect: 'x' } }] } as unknown as Partial<Anthropic.Beta.BetaMessage>;
    const { client } = fakeClient([bad, toolReply]);
    const messages: Anthropic.Beta.BetaMessageParam[] = [firstUserMessage(ctx)];
    const r = await runGuidedRound(io(client, messages));
    expect(r.kind).toBe('proposal');
    const errTurn = messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(errTurn[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_bad', is_error: true });
  });
});
