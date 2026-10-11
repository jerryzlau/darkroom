/** Generative Fill: the store that turns a selection + prompt into a `Patch` in the develop params. */
import { cloneParams, maskBounds, MAX_PATCHES, newPatchId, type Mask, type Patch } from '@darkroom/core';
import { create } from 'zustand';
import { MAX_MASKS } from '../engine/shaders';
import { backend } from '../ipc/backend';
import { toPng } from '../lib/background';
import {
  buildPrompt,
  createGeminiClient,
  DEFAULT_GEMINI_MODEL,
  describeGeminiError,
  fitOutput,
  fromBase64,
  GEMINI_KEY,
  GEMINI_MODEL,
  generateImage,
  IMAGE_SIZES,
  inputSize,
  planCrop,
  upsampleFactor,
  type CropPlan,
  type ImageSize,
} from '../lib/gemini';
import { registerPatchAsset, retryPatchAsset } from '../lib/patchAssets';
import { renderNeutralPixels, toBase64 } from '../lib/renderPreview';
import { useDevelop } from './develop';

export type GeneratePhase = 'idle' | 'rendering' | 'generating' | 'saving';

const SIZE_KEY = 'darkroom.gen.size';

function loadSize(): ImageSize {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return (IMAGE_SIZES as readonly string[]).includes(v ?? '') ? (v as ImageSize) : '1K';
  } catch {
    return '1K';
  }
}

export interface FillTarget {
  mask: Mask;
  index: number;
  bounds: NonNullable<ReturnType<typeof maskBounds>>;
  plan: CropPlan;
  existing: Patch | undefined;
}

/**
 * The fill the active selection would produce, or why it cannot be used.
 * null when there is no photo or no active mask. Reads live `params` so the panel tracks edits.
 */
export function activeFillTarget(): FillTarget | { reason: string; mask: Mask; index: number } | null {
  const d = useDevelop.getState();
  if (!d.source) return null;
  const index = d.params.masks.findIndex((m) => m.id === d.activeMaskId);
  if (index < 0) return null;
  const mask = d.params.masks[index];
  if (index >= MAX_MASKS) return { reason: 'Only the first 8 masks can be used for a fill.', mask, index };
  if (mask.invert) return { reason: 'Turn off Invert on this selection first.', mask, index };
  const bounds = maskBounds(mask, d.source.info);
  if (!bounds) return { reason: 'This selection has no area to fill.', mask, index };
  const plan = planCrop(bounds, d.source.info);
  if (!plan) return { reason: 'This selection has no area to fill.', mask, index };
  const existing = d.params.patches.find((x) => x.maskId === mask.id);
  return { mask, index, bounds, plan, existing };
}

interface GenerateState {
  phase: GeneratePhase;
  error: string | null;
  /** informational line after a successful run (e.g. output size / upsample note) */
  note: string | null;
  /** null until checked */
  hasKey: boolean | null;
  model: string;
  size: ImageSize;
  abort: AbortController | null;
  refreshKey(): Promise<void>;
  setModel(id: string): Promise<void>;
  setSize(s: ImageSize): void;
  generate(prompt: string): Promise<boolean>;
  regenerate(patchId: string): Promise<void>;
  remove(patchId: string): void;
  setEnabled(patchId: string, enabled: boolean): void;
  setOpacity(patchId: string, opacity: number, commit: boolean): void;
  stop(): void;
}

/** Bumped on photo change: stale runs must not write back. */
let turnSeq = 0;

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || /\babort(ed)?\b/i.test(err.message));

export const useGenerate = create<GenerateState>((set, get) => ({
  phase: 'idle',
  error: null,
  note: null,
  hasKey: null,
  model: DEFAULT_GEMINI_MODEL,
  size: loadSize(),
  abort: null,

  async refreshKey() {
    try {
      const [k, m] = await Promise.all([backend().getSetting(GEMINI_KEY), backend().getSetting(GEMINI_MODEL)]);
      set({ hasKey: !!k?.trim(), model: m?.trim() || DEFAULT_GEMINI_MODEL });
    } catch {
      set({ hasKey: false });
    }
  },

  async setModel(id) {
    set({ model: id });
    try {
      await backend().setSetting(GEMINI_MODEL, id);
    } catch (e) {
      set({ error: `Could not save the model: ${e}` });
    }
  },

  setSize(size) {
    set({ size });
    try {
      localStorage.setItem(SIZE_KEY, size);
    } catch {
      /* ignore */
    }
  },

  async generate(raw) {
    const prompt = raw.trim();
    if (!prompt || get().phase !== 'idle') return false;
    const d0 = useDevelop.getState();
    if (!d0.source || d0.imageId == null) return false;
    const imageId = d0.imageId;
    const source = d0.source;
    const target = activeFillTarget();
    if (!target) {
      set({ error: 'Draw a selection first.', note: null });
      return false;
    }
    if ('reason' in target) {
      set({ error: target.reason, note: null });
      return false;
    }
    const { mask, index, plan, existing } = target;
    if (!existing && d0.params.patches.length >= MAX_PATCHES) {
      set({ error: `Up to ${MAX_PATCHES} fills per photo.`, note: null });
      return false;
    }

    const token = ++turnSeq;
    const ctrl = new AbortController();
    // claim the slot before the first await so a double click cannot start two runs
    set({ phase: 'rendering', error: null, note: null, abort: ctrl });
    const live = () => token === turnSeq && useDevelop.getState().imageId === imageId;
    const gone = () => !live() || ctrl.signal.aborted;

    let step: 'prep' | 'generate' | 'save' = 'prep';
    try {
      const key = (await backend().getSetting(GEMINI_KEY))?.trim();
      if (!key) {
        if (token === turnSeq) set({ hasKey: false });
        return false;
      }
      if (gone()) throw new DOMException('Stopped', 'AbortError');
      const model = get().model || DEFAULT_GEMINI_MODEL;
      const size = get().size;

      const ev = source.color.isRaw ? 0.5 : 0;
      const renderParams = cloneParams(d0.committed);
      // never feed the model its own previous output for this selection
      renderParams.patches = renderParams.patches.filter((x) => x.maskId !== mask.id);
      const [iw, ih] = inputSize(plan.px);
      const plain = await renderNeutralPixels(renderParams, plan.rect, iw, ih, { ev, cancellable: false });
      if (gone()) throw new DOMException('Stopped', 'AbortError');
      const masked = await renderNeutralPixels(renderParams, plan.rect, iw, ih, { ev, overlayMask: index, overlayInvert: false, cancellable: false });
      if (gone()) throw new DOMException('Stopped', 'AbortError');
      if (!plain || !masked) throw new Error('Could not render the selection.');
      const plainPng = toBase64(await toPng(plain.px, plain.w, plain.h));
      const maskedPng = toBase64(await toPng(masked.px, masked.w, masked.h));
      if (gone()) throw new DOMException('Stopped', 'AbortError');

      set({ phase: 'generating' });
      step = 'generate';
      const img = await generateImage(createGeminiClient(key), { model, prompt: buildPrompt(prompt), plainPng, maskedPng, ratio: plan.ratio, size }, ctrl.signal);
      if (gone()) throw new DOMException('Stopped', 'AbortError');

      set({ phase: 'saving' });
      step = 'save';
      const bytes = fromBase64(img.data);
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: img.mimeType || 'image/png' }));
      const [ow, oh] = fitOutput(plan.px, size);
      let png: Uint8Array;
      let canvas: HTMLCanvasElement;
      try {
        canvas = document.createElement('canvas');
        canvas.width = ow;
        canvas.height = oh;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not create a canvas.');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, ow, oh);
        png = await toPng(new Uint8Array(ctx.getImageData(0, 0, ow, oh).data.buffer), ow, oh);
      } finally {
        bmp.close();
      }
      const hash = await backend().savePatch(png);
      registerPatchAsset(hash, await createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
      retryPatchAsset(hash);
      if (!live()) return false;

      useDevelop.getState().setAndCommit((p) => {
        p.patches = p.patches.filter((x) => x.maskId !== mask.id);
        p.patches.push({
          id: newPatchId(),
          asset: hash,
          rect: plan.rect,
          area: plan.area,
          maskId: mask.id,
          feather: mask.kind === 'shape' ? mask.shape.feather : 0.02,
          opacity: 1,
          enabled: true,
          prompt,
          model,
          ev,
        });
      }, `Generate: ${prompt.slice(0, 40)}`);
      const f = upsampleFactor(plan.px, size);
      set({
        note:
          f > 1.15
            ? `Fill stored at ${ow}×${oh}; upsampled ${f.toFixed(1)}× on export. Use 2K or 4K for large areas.`
            : `Fill stored at ${ow}×${oh}.`,
      });
      return true;
    } catch (err) {
      if (token === turnSeq) {
        if (ctrl.signal.aborted || isAbort(err)) set({ error: null, note: 'Stopped.' });
        else set({ error: step === 'generate' ? describeGeminiError(err) : String(err instanceof Error ? err.message : err), note: null });
      }
      return false;
    } finally {
      if (token === turnSeq) set({ phase: 'idle', abort: null });
    }
  },

  async regenerate(patchId) {
    const d = useDevelop.getState();
    const patch = d.params.patches.find((x) => x.id === patchId);
    if (!patch) return;
    const mask = patch.maskId ? d.params.masks.find((m) => m.id === patch.maskId) : undefined;
    if (!mask) {
      set({ error: 'The selection for this fill no longer exists. Draw a new one and generate again.', note: null });
      return;
    }
    d.setActiveMask(mask.id);
    await get().generate(patch.prompt);
  },

  remove(patchId) {
    useDevelop.getState().setAndCommit((p) => {
      p.patches = p.patches.filter((x) => x.id !== patchId);
    }, 'Remove Fill');
  },

  setEnabled(patchId, enabled) {
    useDevelop.getState().setAndCommit((p) => {
      const x = p.patches.find((y) => y.id === patchId);
      if (x) x.enabled = enabled;
    }, enabled ? 'Enable Fill' : 'Disable Fill');
  },

  setOpacity(patchId, opacity, commit) {
    const d = useDevelop.getState();
    d.update((p) => {
      const x = p.patches.find((y) => y.id === patchId);
      if (x) x.opacity = Math.min(1, Math.max(0, opacity));
    });
    if (commit) d.commit('Fill Opacity');
  },

  stop() {
    get().abort?.abort();
  },
}));

// A new photo drops any run in flight.
useDevelop.subscribe((s, prev) => {
  if (s.imageId !== prev.imageId) {
    turnSeq++;
    useGenerate.getState().abort?.abort();
    useGenerate.setState({ phase: 'idle', error: null, note: null, abort: null });
  }
});
