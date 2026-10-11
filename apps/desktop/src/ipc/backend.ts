import type {
  AppInfo,
  Collection,
  ExportSpec,
  Folder,
  HistoryEntry,
  ImageDetail,
  ImageQuery,
  ImageRow,
  ImportProgress,
  ImportSummary,
  Preset,
  PresetPatch,
  Snapshot,
} from './types';

/** Everything the UI needs from the native side. Implemented by Tauri and by an in-browser mock. */
export interface Backend {
  readonly kind: 'tauri' | 'mock';
  listFolders(): Promise<Folder[]>;
  listCollections(): Promise<Collection[]>;
  listImages(q: ImageQuery): Promise<ImageRow[]>;
  getImage(id: number): Promise<ImageDetail>;
  saveParams(imageId: number, params: string, edited: boolean, label: string | null, truncateAfter: number | null): Promise<HistoryEntry | null>;
  listHistory(imageId: number): Promise<HistoryEntry[]>;
  clearHistory(imageId: number): Promise<void>;
  listSnapshots(imageId: number): Promise<Snapshot[]>;
  createSnapshot(imageId: number, name: string, params: string): Promise<number>;
  deleteSnapshot(id: number): Promise<void>;
  listPresets(): Promise<Preset[]>;
  /** Upsert by (group, name); an existing preset keeps its id. */
  savePreset(group: string, name: string, params: string, description?: string, source?: 'user' | 'ai'): Promise<number>;
  updatePreset(id: number, patch: PresetPatch): Promise<void>;
  deletePreset(id: number): Promise<void>;
  createCollection(name: string, kind: 'manual' | 'smart', rules: string | null): Promise<number>;
  updateCollection(id: number, name: string, rules: string | null): Promise<void>;
  deleteCollection(id: number): Promise<void>;
  addToCollection(id: number, imageIds: number[]): Promise<void>;
  removeFromCollection(id: number, imageIds: number[]): Promise<void>;
  setRating(ids: number[], rating: number): Promise<void>;
  setFlag(ids: number[], flag: number): Promise<void>;
  setColorLabel(ids: number[], label: string): Promise<void>;
  getKeywords(photoId: number): Promise<string[]>;
  allKeywords(): Promise<[string, number][]>;
  addKeywords(photoIds: number[], names: string[]): Promise<void>;
  removeKeyword(photoIds: number[], name: string): Promise<void>;
  createVirtualCopy(imageId: number): Promise<number>;
  removeImages(imageIds: number[]): Promise<void>;
  removeFolder(id: number): Promise<void>;
  importPaths(paths: string[]): Promise<void>;
  rescanFolder(id: number): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  writeSidecars(imageIds: number[]): Promise<number>;
  revealInFinder(path: string): Promise<void>;
  appInfo(): Promise<AppInfo>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  getPreview(photoId: number): Promise<ArrayBuffer>;
  getRegion(photoId: number, x: number, y: number, w: number, h: number, ow: number, oh: number): Promise<ArrayBuffer>;
  saveEditThumb(imageId: number, jpeg: Uint8Array): Promise<number>;
  resetEditThumb(imageId: number): Promise<void>;
  /** Content-addressed generative-fill PNG store: saves the bytes and returns their sha256 hex (idempotent). */
  savePatch(png: Uint8Array): Promise<string>;
  /** Read a PNG from the patch store by its sha256 hex hash. */
  getPatch(hash: string): Promise<ArrayBuffer>;
  exportBegin(spec: ExportSpec): Promise<number>;
  exportTile(job: number, x: number, y: number, w: number, h: number, data: Uint8Array): Promise<void>;
  exportFinish(job: number): Promise<string>;
  exportCancel(job: number): Promise<void>;
  thumbUrl(imageId: number, rev: number): string;
  pickFolders(title?: string): Promise<string[] | null>;
  pickFiles(): Promise<string[] | null>;
  pickExportFolder(): Promise<string | null>;
  onImportProgress(cb: (p: ImportProgress) => void): () => void;
  onImportDone(cb: (s: ImportSummary) => void): () => void;
}

let current: Backend | null = null;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function initBackend(): Promise<Backend> {
  if (current) return current;
  if (isTauri()) {
    const { createTauriBackend } = await import('./tauri');
    current = await createTauriBackend();
  } else {
    const { createMockBackend } = await import('./mock');
    current = createMockBackend();
  }
  return current;
}

export function backend(): Backend {
  if (!current) throw new Error('backend not initialized');
  return current;
}
