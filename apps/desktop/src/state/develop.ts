import {
  applyPartial,
  asShotTempTint,
  cloneParams,
  DEFAULT_SHAPE_FEATHER,
  defaultParams,
  normalizeParams,
  paramsEqual,
  pickSections,
  resetSection,
  type EditParams,
  type PartialParams,
  type SectionName,
} from '@darkroom/core';
import { create } from 'zustand';
import { defaultView, type ViewState } from '../engine/Engine';
import { parsePreview, type LoadedSource } from '../engine/source';
import { backend } from '../ipc/backend';
import type { HistoryEntry, ImageRow, Preset, Snapshot } from '../ipc/types';
import { requestRedraw } from './engineHub';
import { useLibrary } from './library';
import { toast } from './toast';

export type Tool = 'none' | 'crop' | 'masks' | 'wb' | 'spots' | 'select';

export interface SpotSettings {
  mode: 'heal' | 'clone';
  r: number;
  feather: number;
  opacity: number;
}

export interface BrushSettings {
  size: number; // fraction of long edge
  feather: number; // 0..1
  flow: number; // 0..1
  erase: boolean;
}

export type SelectMode = 'lasso' | 'rect' | 'ellipse';

export interface SelectSettings {
  mode: SelectMode;
  /** edge softness for new selections, fraction of the long edge */
  feather: number;
}

interface DevelopState {
  imageId: number | null;
  image: ImageRow | null;
  source: LoadedSource | null;
  loading: boolean;
  error: string | null;
  params: EditParams;
  base: EditParams;
  committed: EditParams;
  history: HistoryEntry[];
  historyPos: number;
  snapshots: Snapshot[];
  presets: Preset[];
  view: ViewState;
  tool: Tool;
  activeMaskId: string | null;
  brush: BrushSettings;
  select: SelectSettings;
  spot: SpotSettings;
  activeSpotId: string | null;
  clipboard: { sections: SectionName[]; params: PartialParams } | null;
  /** increments whenever the edited thumbnail for the open image is refreshed */
  thumbVersion: number;

  open(imageId: number): Promise<void>;
  close(): void;
  update(fn: (p: EditParams) => void): void;
  replace(p: EditParams): void;
  commit(label: string): void;
  setAndCommit(fn: (p: EditParams) => void, label: string): void;
  undo(): void;
  redo(): void;
  goHistory(index: number): void;
  resetAll(): void;
  resetSection(s: SectionName): void;
  applyPreset(params: PartialParams, name: string): void;
  copy(sections: SectionName[]): void;
  paste(): void;
  setView(v: Partial<ViewState>): void;
  setTool(t: Tool): void;
  setActiveMask(id: string | null): void;
  setBrush(b: Partial<BrushSettings>): void;
  setSelect(s: Partial<SelectSettings>): void;
  setSpot(s: Partial<SpotSettings>): void;
  setActiveSpot(id: string | null): void;
  loadPresets(): Promise<void>;
  loadSnapshots(): Promise<void>;
}

const initial = defaultParams();
let saveChain: Promise<unknown> = Promise.resolve();
let openToken = 0;
let pendingId: number | null = null;
let thumbTimer: ReturnType<typeof setTimeout> | null = null;

/** Registered by the canvas: renders and stores an edited thumbnail for the open image. */
let thumbnailer: ((imageId: number, edited: boolean) => Promise<void>) | null = null;
export function setThumbnailer(f: typeof thumbnailer) {
  thumbnailer = f;
}

function scheduleThumb(imageId: number, edited: boolean) {
  if (thumbTimer) clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    thumbTimer = null;
    thumbnailer?.(imageId, edited).catch((e) => console.warn('thumbnail', e));
  }, 900);
}

export function flushThumb() {
  if (thumbTimer) {
    clearTimeout(thumbTimer);
    thumbTimer = null;
    const s = useDevelop.getState();
    if (s.imageId != null) void thumbnailer?.(s.imageId, !paramsEqual(s.params, s.base));
  }
}

const loadBrush = (): BrushSettings => {
  try {
    return { size: 0.04, feather: 0.6, flow: 1, ...JSON.parse(localStorage.getItem('darkroom.brush') ?? '{}'), erase: false };
  } catch {
    return { size: 0.04, feather: 0.6, flow: 1, erase: false };
  }
};

const loadSelect = (): SelectSettings => {
  const d: SelectSettings = { mode: 'lasso', feather: DEFAULT_SHAPE_FEATHER };
  try {
    const o = JSON.parse(localStorage.getItem('darkroom.select') ?? '{}') as Partial<SelectSettings>;
    return {
      mode: o.mode === 'rect' || o.mode === 'ellipse' || o.mode === 'lasso' ? o.mode : d.mode,
      feather: typeof o.feather === 'number' && Number.isFinite(o.feather) ? Math.min(0.5, Math.max(0, o.feather)) : d.feather,
    };
  } catch {
    return d;
  }
};

export const useDevelop = create<DevelopState>((set, get) => ({
  imageId: null,
  image: null,
  source: null,
  loading: false,
  error: null,
  params: initial,
  base: initial,
  committed: initial,
  history: [],
  historyPos: -1,
  snapshots: [],
  presets: [],
  view: defaultView(),
  tool: 'none',
  activeMaskId: null,
  brush: loadBrush(),
  select: loadSelect(),
  spot: { mode: 'heal', r: 0.012, feather: 0.35, opacity: 1 },
  activeSpotId: null,
  clipboard: null,
  thumbVersion: 0,

  async open(imageId) {
    if (pendingId === imageId) return;
    if (get().imageId === imageId && get().source) {
      // back to the photo on screen while another was loading: cancel that load
      if (pendingId != null) {
        openToken++;
        pendingId = null;
        set({ loading: false });
      }
      return;
    }
    flushThumb();
    const token = ++openToken;
    pendingId = imageId;
    // imageId keeps pointing at the photo on screen until the new one is ready,
    // so edits made while loading can never be saved onto the wrong photo.
    set({ loading: true, error: null });
    const b = backend();
    try {
      const detail = await b.getImage(imageId);
      if (token !== openToken) return;
      const buf = await b.getPreview(detail.image.photoId);
      if (token !== openToken) return;
      const source = parsePreview(buf);
      const shot = asShotTempTint(source.color);
      const base = defaultParams({ isRaw: source.color.isRaw, asShotTemp: shot.temp, asShotTint: shot.tint });
      let params = base;
      if (detail.params) {
        try {
          params = normalizeParams(JSON.parse(detail.params), base);
        } catch {
          toast('Stored edit could not be read; showing defaults', 'warn');
        }
      }
      let history = await b.listHistory(imageId);
      if (token !== openToken) return;
      if (history.length === 0) {
        const e = await b.saveParams(imageId, JSON.stringify(params), !paramsEqual(params, base), 'Import', null);
        if (e) history = [e];
      }
      const snapshots = await b.listSnapshots(imageId);
      if (token !== openToken) return;
      pendingId = null;
      set({
        imageId,
        image: detail.image,
        tool: get().tool === 'crop' ? 'none' : get().tool,
        activeMaskId: null,
        activeSpotId: null,
        source,
        base,
        params,
        committed: params,
        history,
        historyPos: history.length - 1,
        snapshots,
        loading: false,
        view: { ...get().view, mode: 'fit', center: [0.5, 0.5], before: false, overlayMask: -1, cropMode: false },
      });
      requestRedraw();
      // Warm the backend's preview cache for the neighbours.
      const imgs = useLibrary.getState().images;
      const i = imgs.findIndex((x) => x.id === imageId);
      for (const n of [imgs[i + 1], imgs[i - 1]]) {
        if (n && n.photoId !== detail.image.photoId) b.getPreview(n.photoId).catch(() => {});
      }
    } catch (e) {
      if (token !== openToken) return;
      pendingId = null;
      set({ loading: false, error: String(e), source: null, imageId: null, image: null });
      toast(`Could not open photo: ${e}`, 'error');
    }
  },

  close() {
    flushThumb();
    openToken++;
    pendingId = null;
    set({ imageId: null, image: null, source: null, history: [], historyPos: -1 });
  },

  update(fn) {
    const p = cloneParams(get().params);
    fn(p);
    set({ params: p });
    requestRedraw();
  },

  replace(p) {
    set({ params: p });
    requestRedraw();
  },

  commit(label) {
    const s = get();
    if (s.imageId == null) return;
    if (paramsEqual(s.params, s.committed)) return;
    const imageId = s.imageId;
    const params = s.params;
    const json = JSON.stringify(params);
    const edited = !paramsEqual(params, s.base);
    const keep = s.history[s.historyPos];
    const truncating = s.historyPos < s.history.length - 1;
    const placeholder: HistoryEntry = { id: -1, label, params: json, createdAt: new Date().toISOString() };
    const history = [...s.history.slice(0, s.historyPos + 1), placeholder];
    set({ committed: params, history, historyPos: history.length - 1 });
    useLibrary.getState().patchImage(imageId, { edited });
    saveChain = saveChain.then(async () => {
      try {
        const e = await backend().saveParams(imageId, json, edited, label, truncating && keep && keep.id > 0 ? keep.id : null);
        if (e) placeholder.id = e.id;
      } catch (err) {
        toast(`Could not save edit: ${err}`, 'error');
      }
    });
    scheduleThumb(imageId, edited);
  },

  setAndCommit(fn, label) {
    get().update(fn);
    get().commit(label);
  },

  undo() {
    const s = get();
    if (s.historyPos > 0) get().goHistory(s.historyPos - 1);
  },

  redo() {
    const s = get();
    if (s.historyPos < s.history.length - 1) get().goHistory(s.historyPos + 1);
  },

  goHistory(index) {
    const s = get();
    const e = s.history[index];
    if (!e || s.imageId == null) return;
    const params = normalizeParams(JSON.parse(e.params), s.base);
    set({ params, committed: params, historyPos: index });
    requestRedraw();
    const imageId = s.imageId;
    const edited = !paramsEqual(params, s.base);
    useLibrary.getState().patchImage(imageId, { edited });
    saveChain = saveChain.then(() => backend().saveParams(imageId, e.params, edited, null, null).catch(() => {}));
    scheduleThumb(imageId, edited);
  },

  resetAll() {
    const s = get();
    get().replace(cloneParams(s.base));
    get().commit('Reset');
  },

  resetSection(section) {
    const s = get();
    get().replace(resetSection(s.params, section, s.base));
    get().commit(`Reset ${section}`);
  },

  applyPreset(partial, name) {
    const s = get();
    get().replace(applyPartial(s.params, partial, s.base));
    get().commit(`Preset: ${name}`);
  },

  copy(sections) {
    const s = get();
    set({ clipboard: { sections, params: pickSections(s.params, sections) } });
    toast(`Copied ${sections.length} setting group${sections.length === 1 ? '' : 's'}`);
  },

  paste() {
    const s = get();
    if (!s.clipboard) return toast('Nothing to paste. Copy settings first (⇧⌘C).', 'warn');
    get().replace(applyPartial(s.params, s.clipboard.params, s.base));
    get().commit('Paste Settings');
  },

  setView(v) {
    set({ view: { ...get().view, ...v } });
    requestRedraw();
  },

  setTool(t) {
    const cur = get().tool;
    const tool = cur === t ? 'none' : t;
    set({ tool, view: { ...get().view, cropMode: tool === 'crop', overlayMask: tool === 'masks' || tool === 'select' ? get().view.overlayMask : -1 } });
    if (cur === 'crop' && tool !== 'crop') get().commit('Crop');
    requestRedraw();
  },

  setActiveMask(id) {
    set({ activeMaskId: id });
  },

  setBrush(b) {
    const brush = { ...get().brush, ...b };
    set({ brush });
    try {
      localStorage.setItem('darkroom.brush', JSON.stringify(brush));
    } catch {
      /* ignore */
    }
  },

  setSelect(sl) {
    const select = { ...get().select, ...sl };
    set({ select });
    try {
      localStorage.setItem('darkroom.select', JSON.stringify(select));
    } catch {
      /* ignore */
    }
  },

  setSpot(sp) {
    set({ spot: { ...get().spot, ...sp } });
  },

  setActiveSpot(id) {
    set({ activeSpotId: id });
  },

  async loadPresets() {
    try {
      set({ presets: await backend().listPresets() });
    } catch (e) {
      toast(String(e), 'error');
    }
  },

  async loadSnapshots() {
    const id = get().imageId;
    if (id == null) return;
    set({ snapshots: await backend().listSnapshots(id) });
  },
}));

/** Apply settings to many images without opening them (Library paste / presets / sync). */
export async function applyToImages(ids: number[], partial: PartialParams, label: string) {
  const b = backend();
  let n = 0;
  for (const id of ids) {
    try {
      const d = await b.getImage(id);
      const base = defaultParams({ isRaw: d.image.format === 'raw' });
      const cur = d.params ? normalizeParams(JSON.parse(d.params), base) : base;
      const next = applyPartial(cur, partial, base);
      await b.saveParams(id, JSON.stringify(next), true, label, null);
      useLibrary.getState().patchImage(id, { edited: true });
      n++;
    } catch (e) {
      toast(`Could not update image ${id}: ${e}`, 'error');
    }
  }
  return n;
}
