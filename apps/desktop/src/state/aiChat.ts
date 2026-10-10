/** AI Edit chat: conversation state and the glue between the model loop and the develop store. */
import Anthropic from '@anthropic-ai/sdk';
import { create } from 'zustand';
import { backend } from '../ipc/backend';
import { applyPatch, compactParams, createClient, DEFAULT_MODEL, describeError, runTurn, SETTING_KEY, SETTING_MODEL } from '../lib/ai';
import { captureContext } from '../lib/aiContext';
import { useDevelop } from './develop';
import { useGuided } from './guided';

export interface ChatRow {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** summaries of settings changes applied during this reply */
  patches?: string[];
  error?: string;
  busy?: boolean;
  phase?: 'thinking' | 'adjusting';
}

interface AiChatState {
  /** API conversation, append-only within a chat. */
  messages: Anthropic.Beta.BetaMessageParam[];
  display: ChatRow[];
  status: 'idle' | 'streaming';
  abort: AbortController | null;
  /** null until checked */
  hasKey: boolean | null;
  refreshKey(): Promise<void>;
  send(text: string): Promise<void>;
  stop(): void;
  clear(): void;
}

let rowSeq = 0;
/** Bumped by clear(): stale turns must not write back. */
let turnSeq = 0;

export const useAiChat = create<AiChatState>((set, get) => ({
  messages: [],
  display: [],
  status: 'idle',
  abort: null,
  hasKey: null,

  async refreshKey() {
    try {
      const k = await backend().getSetting(SETTING_KEY);
      set({ hasKey: !!k?.trim() });
    } catch {
      set({ hasKey: false });
    }
  },

  async send(raw) {
    const text = raw.trim();
    if (!text || get().status === 'streaming') return;
    if (useGuided.getState().phase === 'analyzing') {
      set({ display: [...get().display, { id: ++rowSeq, role: 'assistant', text: '', error: 'Finish the guided edit round first.' }] });
      return;
    }
    const d0 = useDevelop.getState();
    if (!d0.source || d0.imageId == null) return;
    const imageId = d0.imageId;
    const b = backend();
    const key = (await b.getSetting(SETTING_KEY))?.trim();
    if (!key) {
      set({ hasKey: false });
      return;
    }
    const model = (await b.getSetting(SETTING_MODEL))?.trim() || DEFAULT_MODEL;
    if (get().status === 'streaming') return;

    const token = ++turnSeq;
    const ctrl = new AbortController();
    const userRow: ChatRow = { id: ++rowSeq, role: 'user', text };
    const replyId = ++rowSeq;
    set({
      status: 'streaming',
      abort: ctrl,
      hasKey: true,
      display: [...get().display, userRow, { id: replyId, role: 'assistant', text: '', busy: true, phase: 'thinking' }],
    });

    const sameImage = () => useDevelop.getState().imageId === imageId;
    const live = () => token === turnSeq && sameImage();
    const patchRow = (fn: (r: ChatRow) => ChatRow) => {
      if (token !== turnSeq) return;
      set({ display: get().display.map((r) => (r.id === replyId ? fn(r) : r)) });
    };

    // rAF-coalesced live preview, always derived from `committed`
    let pendingPatch: unknown;
    let raf = 0;
    const cancelPreview = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const revert = () => {
      cancelPreview();
      if (!sameImage()) return;
      const d = useDevelop.getState();
      d.replace(d.committed);
    };

    const messages = [...get().messages];
    const userIndex = messages.length;
    let textAtRequest = '';
    let sep = '';
    let firstDelta = true;
    let ok = false;
    try {
      const context = await captureContext();
      if (!live()) return;
      messages.push({ role: 'user', content: [...context, { type: 'text', text }] });
      const result = await runTurn({
        client: createClient(key),
        model,
        messages,
        signal: ctrl.signal,
        onRequest(retry) {
          firstDelta = true;
          if (retry) {
            revert();
            patchRow((r) => ({ ...r, text: textAtRequest, phase: 'thinking' }));
          } else {
            textAtRequest = get().display.find((r) => r.id === replyId)?.text ?? '';
            sep = textAtRequest && !/\s$/.test(textAtRequest) ? '\n\n' : '';
          }
        },
        onText(delta) {
          const prefix = firstDelta ? sep : '';
          firstDelta = false;
          patchRow((r) => ({ ...r, text: r.text + prefix + delta, phase: undefined }));
        },
        onToolStart() {
          patchRow((r) => ({ ...r, phase: 'adjusting' }));
        },
        onLivePatch(patch) {
          pendingPatch = patch;
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (!live() || ctrl.signal.aborted) return;
            const d = useDevelop.getState();
            d.replace(applyPatch(d.committed, d.base, pendingPatch).params);
          });
        },
        onRefusal(explanation) {
          revert();
          patchRow((r) => ({ ...r, busy: false, phase: undefined, error: explanation || 'The model declined this request.' }));
        },
        runTool(input) {
          cancelPreview();
          if (!live()) throw new Error('The photo changed before the settings could be applied.');
          const d = useDevelop.getState();
          const { params, dropped } = applyPatch(d.committed, d.base, input.patch);
          const label = `AI: ${input.summary.trim().slice(0, 60) || 'Adjust'}`;
          d.replace(params);
          d.commit(label);
          patchRow((r) => ({ ...r, phase: 'thinking', patches: [...(r.patches ?? []), input.summary.trim() || 'Adjusted settings'] }));
          return JSON.stringify({ applied: true, label, ...(dropped.length ? { dropped } : {}), settings: compactParams(params) });
        },
      });
      if (result === 'refused') {
        // drop only the dangling user turn; anything the model already applied stays in history
        if (messages.length === userIndex + 1) messages.pop();
      }
      ok = result === 'done';
    } catch (err) {
      revert();
      if (messages.length === userIndex + 1) messages.pop();
      if (token === turnSeq) {
        const msg = describeError(err);
        patchRow((r) => ({ ...r, busy: false, phase: undefined, error: msg }));
      }
    } finally {
      cancelPreview();
      if (token === turnSeq) {
        if (ok) patchRow((r) => ({ ...r, busy: false, phase: undefined }));
        set({ messages, status: 'idle', abort: null });
      }
    }
  },

  stop() {
    get().abort?.abort();
  },

  clear() {
    turnSeq++;
    get().abort?.abort();
    set({ messages: [], display: [], status: 'idle', abort: null });
  },
}));

// A new photo starts a new conversation.
useDevelop.subscribe((s, prev) => {
  if (s.imageId !== prev.imageId) useAiChat.getState().clear();
});
