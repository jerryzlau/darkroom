import { create } from 'zustand';
import { backend } from '../ipc/backend';
import type { Collection, Folder, ImageQuery, ImageRow, ImportProgress, ImportSummary } from '../ipc/types';
import { toast } from './toast';

export type LibraryView = 'grid' | 'loupe';

interface LibraryState {
  folders: Folder[];
  collections: Collection[];
  images: ImageRow[];
  query: ImageQuery;
  selected: Set<number>;
  activeId: number | null;
  anchorId: number | null;
  thumbSize: number;
  view: LibraryView;
  importProgress: ImportProgress | null;
  keywords: [string, number][];
  loaded: boolean;

  refresh(): Promise<void>;
  refreshImages(): Promise<void>;
  refreshSidebar(): Promise<void>;
  setQuery(q: Partial<ImageQuery>): void;
  select(id: number, mode?: 'single' | 'toggle' | 'range'): void;
  selectAll(): void;
  selectNone(): void;
  moveActive(delta: number, extend?: boolean): void;
  targetIds(): number[];
  setRating(r: number, ids?: number[]): void;
  setFlag(f: number, ids?: number[]): void;
  setColorLabel(c: string, ids?: number[]): void;
  patchImage(id: number, patch: Partial<ImageRow>): void;
  setThumbSize(s: number): void;
  setView(v: LibraryView): void;
  setImportProgress(p: ImportProgress | null): void;
  importDone(s: ImportSummary): void;
}

const loadPrefs = (): Partial<Pick<LibraryState, 'thumbSize' | 'query'>> => {
  try {
    return JSON.parse(localStorage.getItem('darkroom.library') ?? '{}');
  } catch {
    return {};
  }
};

const savePrefs = (s: Pick<LibraryState, 'thumbSize' | 'query'>) => {
  try {
    localStorage.setItem('darkroom.library', JSON.stringify({ thumbSize: s.thumbSize, query: s.query }));
  } catch {
    /* ignore */
  }
};

const prefs = loadPrefs();

export const useLibrary = create<LibraryState>((set, get) => ({
  folders: [],
  collections: [],
  images: [],
  query: { source: 'all', sort: 'captured', desc: false, flag: 'all', recursive: true, ...(prefs.query ?? {}) },
  selected: new Set(),
  activeId: null,
  anchorId: null,
  thumbSize: prefs.thumbSize ?? 180,
  view: 'grid',
  importProgress: null,
  keywords: [],
  loaded: false,

  async refresh() {
    await Promise.all([get().refreshSidebar(), get().refreshImages()]);
  },

  async refreshSidebar() {
    const b = backend();
    const [folders, collections, keywords] = await Promise.all([b.listFolders(), b.listCollections(), b.allKeywords()]);
    set({ folders, collections, keywords });
  },

  async refreshImages() {
    const { query } = get();
    try {
      const images = await backend().listImages(query);
      const ids = new Set(images.map((i) => i.id));
      const selected = new Set([...get().selected].filter((id) => ids.has(id)));
      let activeId = get().activeId;
      if (activeId == null || !ids.has(activeId)) activeId = images[0]?.id ?? null;
      if (selected.size === 0 && activeId != null) selected.add(activeId);
      set({ images, selected, activeId, loaded: true });
    } catch (e) {
      toast(`Could not load photos: ${e}`, 'error');
    }
  },

  setQuery(q) {
    const query = { ...get().query, ...q };
    set({ query });
    savePrefs({ thumbSize: get().thumbSize, query });
    void get().refreshImages();
  },

  select(id, mode = 'single') {
    const { selected, anchorId, images } = get();
    if (mode === 'toggle') {
      const s = new Set(selected);
      if (s.has(id) && s.size > 1) s.delete(id);
      else s.add(id);
      set({ selected: s, activeId: id, anchorId: id });
    } else if (mode === 'range' && anchorId != null) {
      const a = images.findIndex((i) => i.id === anchorId);
      const b = images.findIndex((i) => i.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      set({ selected: new Set(images.slice(lo, hi + 1).map((i) => i.id)), activeId: id });
    } else {
      set({ selected: new Set([id]), activeId: id, anchorId: id });
    }
  },

  selectAll() {
    set({ selected: new Set(get().images.map((i) => i.id)) });
  },

  selectNone() {
    const a = get().activeId;
    set({ selected: new Set(a != null ? [a] : []) });
  },

  moveActive(delta, extend = false) {
    const { images, activeId } = get();
    if (!images.length) return;
    const i = Math.max(0, images.findIndex((x) => x.id === activeId));
    const n = Math.min(images.length - 1, Math.max(0, i + delta));
    const id = images[n].id;
    if (extend) get().select(id, 'range');
    else get().select(id);
  },

  targetIds() {
    const { selected, activeId } = get();
    if (selected.size > 0) return [...selected];
    return activeId != null ? [activeId] : [];
  },

  setRating(r, ids) {
    const t = ids ?? get().targetIds();
    if (!t.length) return;
    set({ images: get().images.map((i) => (t.includes(i.id) ? { ...i, rating: r } : i)) });
    backend().setRating(t, r).catch((e) => toast(String(e), 'error'));
  },

  setFlag(f, ids) {
    const t = ids ?? get().targetIds();
    if (!t.length) return;
    set({ images: get().images.map((i) => (t.includes(i.id) ? { ...i, flag: f } : i)) });
    backend().setFlag(t, f).catch((e) => toast(String(e), 'error'));
  },

  setColorLabel(c, ids) {
    const t = ids ?? get().targetIds();
    if (!t.length) return;
    // toggling the same label clears it
    const all = get().images.filter((i) => t.includes(i.id));
    const label = all.length && all.every((i) => i.colorLabel === c) ? '' : c;
    set({ images: get().images.map((i) => (t.includes(i.id) ? { ...i, colorLabel: label } : i)) });
    backend().setColorLabel(t, label).catch((e) => toast(String(e), 'error'));
  },

  patchImage(id, patch) {
    set({ images: get().images.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  },

  setThumbSize(s) {
    set({ thumbSize: s });
    savePrefs({ thumbSize: s, query: get().query });
  },

  setView(v) {
    set({ view: v });
  },

  setImportProgress(p) {
    set({ importProgress: p });
  },

  importDone(s) {
    set({ importProgress: null });
    const parts = [`${s.added} added`];
    if (s.updated) parts.push(`${s.updated} updated`);
    if (s.unchanged) parts.push(`${s.unchanged} unchanged`);
    if (s.missing) parts.push(`${s.missing} missing`);
    toast(`Import finished: ${parts.join(', ')}`, s.errors.length ? 'warn' : 'info');
    if (s.errors.length) {
      console.warn('import errors', s.errors);
      toast(`${s.errors.length} file(s) could not be read. First: ${s.errors[0]}`, 'error');
    }
    void get().refresh();
  },
}));
