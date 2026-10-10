/** Guided Edit: round-by-round session state and the glue between the model protocol and the develop store. */
import Anthropic from '@anthropic-ai/sdk';
import type { EditParams, PartialParams, SectionName } from '@darkroom/core';
import { create } from 'zustand';
import { backend } from '../ipc/backend';
import { compactParams, createClient, DEFAULT_MODEL, describeError, SETTING_KEY, SETTING_MODEL } from '../lib/ai';
import { captureContext } from '../lib/aiContext';
import { buildFilterFromSession, choiceMessage, firstUserMessage, MAX_GUIDED_ROUNDS, runGuidedRound, sanitizeOptions, type Choice } from '../lib/guided';
import { cancelPreviewRenders, renderParamsThumb } from '../lib/renderPreview';
import { useAiChat } from './aiChat';
import { useDevelop } from './develop';

export type GuidedPhase = 'idle' | 'analyzing' | 'choosing' | 'done';

export interface GuidedOption {
  id: string;
  title: string;
  why: string;
  patch: Record<string, unknown>;
  params: EditParams;
  thumb: string | null;
  dropped: string[];
}

export interface GuidedRound {
  index: number;
  aspect: string;
  options: GuidedOption[];
  /** index of the picked option, 'skipped', or null while undecided */
  choice: number | 'skipped' | null;
  /** last round of the session */
  done: boolean;
}

interface GuidedState {
  phase: GuidedPhase;
  error: string | null;
  assessment: string | null;
  doneReason: string | null;
  rounds: GuidedRound[];
  /** committed params when the session started */
  startParams: EditParams | null;
  imageId: number | null;
  /** option id currently previewed on the canvas */
  previewing: string | null;
  abort: AbortController | null;
  start(): Promise<void>;
  choose(optionId: string): Promise<void>;
  skip(): Promise<void>;
  finish(): void;
  preview(optionId: string | null): void;
  reset(): void;
  stop(): void;
}

const INITIAL = {
  phase: 'idle' as GuidedPhase,
  error: null,
  assessment: null,
  doneReason: null,
  rounds: [] as GuidedRound[],
  startParams: null,
  imageId: null,
  previewing: null,
  abort: null,
};

/** API conversation of the current session. */
let messages: Anthropic.Beta.BetaMessageParam[] = [];
/** tool_use id of the propose_options call awaiting the user's choice */
let pendingToolUseId: string | null = null;
/** Bumped by start()/reset(): stale requests must not write back. */
let turnSeq = 0;
/** Bumped per round: stale thumbnails must not write back. */
let thumbGen = 0;
/** Client and model of the current session. */
let session: { client: Anthropic; model: string } | null = null;

const sameImage = () => {
  const id = useGuided.getState().imageId;
  return id != null && useDevelop.getState().imageId === id;
};

/** Show committed params again (drops any option preview). */
function revert() {
  if (sameImage()) {
    const d = useDevelop.getState();
    d.replace(d.committed);
  }
  useGuided.setState({ previewing: null });
}

const isAbort = (err: unknown, signal: AbortSignal) => signal.aborted || err instanceof Anthropic.APIUserAbortError;

export const useGuided = create<GuidedState>((set, get) => {
  /** Request the next round and turn it into options. */
  async function runRound(token: number): Promise<void> {
    const live = () => token === turnSeq && sameImage();
    if (!session || !live()) return;
    const { client, model } = session;
    let emptyRetries = 0;
    for (;;) {
      const ctrl = new AbortController();
      set({ phase: 'analyzing', abort: ctrl, error: null });
      try {
        const r = await runGuidedRound({ client, model, messages, signal: ctrl.signal });
        if (!live()) return;
        set({ abort: null });
        if (r.kind === 'refused') {
          if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
          set({ error: r.explanation || 'The model declined this request.', phase: get().rounds.length ? 'done' : 'idle' });
          return;
        }
        const { proposal, toolUseId } = r;
        pendingToolUseId = toolUseId;
        const d = useDevelop.getState();
        const options = sanitizeOptions(proposal, d.committed, d.base);
        if (get().assessment == null && proposal.assessment) set({ assessment: proposal.assessment });
        if (options.length === 0 && !proposal.done) {
          if (emptyRetries++ >= 1) {
            set({ phase: get().rounds.length ? 'done' : 'idle', doneReason: get().doneReason ?? 'No further changes were proposed.' });
            return;
          }
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: 'All proposed options were no-ops or duplicates of the current settings. Propose clearly different options.',
              },
            ],
          });
          continue;
        }
        const index = get().rounds.length;
        const round: GuidedRound = {
          index,
          aspect: proposal.aspect,
          options: options.map((o, i) => ({ id: `r${index}o${i}`, title: o.title, why: o.why, patch: o.patch, params: o.params, dropped: o.dropped, thumb: null })),
          choice: null,
          done: proposal.done || index + 1 >= MAX_GUIDED_ROUNDS,
        };
        set({
          rounds: [...get().rounds, round],
          doneReason: proposal.doneReason ?? get().doneReason,
          phase: options.length === 0 ? 'done' : 'choosing',
        });
        // thumbnails fill in progressively
        const gen = ++thumbGen;
        for (const o of round.options) {
          void renderParamsThumb(o.params, 192, 0.8, { scope: 'guided' }).then(
            (url) => {
              if (!url || gen !== thumbGen || !live()) return;
              set({
                rounds: get().rounds.map((rd) =>
                  rd.index === index ? { ...rd, options: rd.options.map((x) => (x.id === o.id ? { ...x, thumb: url } : x)) } : rd,
                ),
              });
            },
            (e) => console.warn('Guided thumbnail failed', e),
          );
        }
        return;
      } catch (err) {
        if (token !== turnSeq) return;
        revert();
        if (isAbort(err, ctrl.signal)) return; // stop()/finish() already set the phase
        if (!sameImage()) return;
        // messages may end with an unanswered tool_use: no retry on this conversation
        set({ abort: null, error: describeError(err), phase: get().rounds.length ? 'done' : 'idle' });
        return;
      }
    }
  }

  /** Record the choice for the current round and request the next one. */
  async function decide(optionId: string | null): Promise<void> {
    if (get().phase !== 'choosing' || !sameImage()) return;
    const token = turnSeq;
    const rounds = get().rounds;
    const round = rounds[rounds.length - 1];
    if (!round || round.choice !== null) return;
    revert();
    let choice: Choice = { kind: 'skipped' };
    let picked: number | 'skipped' = 'skipped';
    if (optionId != null) {
      const i = round.options.findIndex((o) => o.id === optionId);
      if (i < 0) return;
      const opt = round.options[i];
      const d = useDevelop.getState();
      d.replace(opt.params);
      d.commit(`Guided: ${opt.title.slice(0, 60)}`);
      choice = { kind: 'picked', title: opt.title };
      picked = i;
    }
    thumbGen++;
    cancelPreviewRenders('guided');
    set({ rounds: rounds.map((r) => (r === round ? { ...r, choice: picked } : r)), error: null });
    if (round.done || !pendingToolUseId) {
      set({ phase: 'done' });
      return;
    }
    const toolUseId = pendingToolUseId;
    pendingToolUseId = null;
    set({ phase: 'analyzing' });
    const context = await captureContext();
    if (token !== turnSeq || !sameImage() || get().phase !== 'analyzing') return;
    messages.push(choiceMessage(toolUseId, choice, compactParams(useDevelop.getState().committed), context));
    await runRound(token);
  }

  return {
    ...INITIAL,

    async start() {
      const g = get();
      if (g.phase !== 'idle' && g.phase !== 'done') return;
      const d0 = useDevelop.getState();
      if (!d0.source || d0.imageId == null) return;
      if (useAiChat.getState().status === 'streaming') {
        set({ error: 'Finish the chat reply first.' });
        return;
      }
      const imageId = d0.imageId;
      const token = ++turnSeq;
      // claim the session before awaiting settings so a double click cannot start two
      thumbGen++;
      cancelPreviewRenders('guided');
      messages = [];
      pendingToolUseId = null;
      session = null;
      set({ ...INITIAL, phase: 'analyzing', imageId, startParams: d0.committed });
      const fail = (error: string) => {
        if (token === turnSeq) set({ phase: 'idle', error, startParams: null });
      };
      try {
        const b = backend();
        const key = (await b.getSetting(SETTING_KEY))?.trim();
        if (token !== turnSeq) return;
        if (!key) return fail('Add an Anthropic API key in Settings.');
        const model = (await b.getSetting(SETTING_MODEL))?.trim() || DEFAULT_MODEL;
        if (token !== turnSeq || !sameImage()) return;
        session = { client: createClient(key), model };
        // the session starts from the latest committed state
        set({ startParams: useDevelop.getState().committed });
        const context = await captureContext();
        if (token !== turnSeq || !sameImage() || get().phase !== 'analyzing') return;
        messages = [firstUserMessage(context)];
      } catch (err) {
        return fail(describeError(err));
      }
      await runRound(token);
    },

    choose(optionId) {
      return decide(optionId);
    },

    skip() {
      return decide(null);
    },

    finish() {
      get().abort?.abort();
      thumbGen++;
      cancelPreviewRenders('guided');
      revert();
      const rounds = get().rounds;
      const last = rounds[rounds.length - 1];
      set({
        phase: 'done',
        abort: null,
        rounds: last && last.choice === null ? rounds.map((r) => (r === last ? { ...r, choice: 'skipped' as const } : r)) : rounds,
      });
    },

    preview(optionId) {
      if (get().phase !== 'choosing' || !sameImage()) return;
      const d = useDevelop.getState();
      if (optionId == null) {
        d.replace(d.committed);
        set({ previewing: null });
        return;
      }
      const last = get().rounds[get().rounds.length - 1];
      const opt = last?.options.find((o) => o.id === optionId);
      if (!opt) return;
      d.replace(opt.params);
      set({ previewing: optionId });
    },

    reset() {
      turnSeq++;
      thumbGen++;
      get().abort?.abort();
      revert();
      cancelPreviewRenders('guided');
      messages = [];
      pendingToolUseId = null;
      session = null;
      set({ ...INITIAL });
    },

    stop() {
      get().abort?.abort();
      revert();
      const rounds = get().rounds;
      const last = rounds[rounds.length - 1];
      set({ abort: null, phase: last && last.choice === null ? 'choosing' : rounds.length ? 'done' : 'idle' });
    },
  };
});

/** Filter built from the session so far (start → current committed), or null without a session. */
export function guidedFilter(): { params: PartialParams; sections: SectionName[] } | null {
  const start = useGuided.getState().startParams;
  if (!start) return null;
  return buildFilterFromSession(start, useDevelop.getState().committed);
}

/** Picked options and a short description of the session (≤ 300 chars). */
export function guidedSummary(): { picks: { aspect: string; title: string }[]; description: string } {
  const g = useGuided.getState();
  const picks = g.rounds.flatMap((r) => (typeof r.choice === 'number' ? [{ aspect: r.aspect, title: r.options[r.choice].title }] : []));
  const first = g.assessment ? (g.assessment.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? g.assessment) : '';
  let description = [first, picks.map((p) => p.title).join(', ')].filter(Boolean).join(' ').trim();
  if (description.length > 300) description = `${description.slice(0, 299).trimEnd()}…`;
  return { picks, description };
}

// A new photo ends the session.
useDevelop.subscribe((s, prev) => {
  if (s.imageId !== prev.imageId) useGuided.getState().reset();
});
