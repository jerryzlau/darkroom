export interface Folder {
  id: number;
  path: string;
  name: string;
  parentId: number | null;
  count: number;
}

export interface Collection {
  id: number;
  name: string;
  kind: 'manual' | 'smart';
  rules: string | null;
  count: number;
}

export interface ImageRow {
  id: number;
  photoId: number;
  folderId: number;
  copyName: string | null;
  edited: boolean;
  rating: number;
  flag: number;
  colorLabel: string;
  thumbRev: number;
  thumbOk: boolean;
  missing: boolean;
  updatedAt: string;
  importedAt: string;
  path: string;
  filename: string;
  format: string;
  fileSize: number;
  mtime: number;
  width: number;
  height: number;
  capturedAt: string | null;
  make: string | null;
  model: string | null;
  lens: string | null;
  focalLength: number | null;
  fnumber: number | null;
  exposureTime: string | null;
  iso: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
}

export type FlagFilter = 'all' | 'picked' | 'rejected' | 'unflagged' | 'notRejected';
export type SortKey = 'captured' | 'filename' | 'rating' | 'imported' | 'edited';

export interface ImageQuery {
  source: 'all' | 'folder' | 'collection' | 'lastImport';
  sourceId?: number | null;
  recursive?: boolean;
  minRating?: number;
  ratingOp?: '>=' | '=' | '<=';
  flag?: FlagFilter;
  colorLabel?: string;
  text?: string;
  edited?: boolean | null;
  format?: string;
  keyword?: string;
  sort?: SortKey;
  desc?: boolean;
}

export interface SmartRules {
  minRating?: number;
  ratingOp?: '>=' | '=' | '<=';
  flag?: FlagFilter;
  colorLabel?: string;
  text?: string;
  edited?: boolean | null;
  format?: string;
  keyword?: string;
  camera?: string;
  lens?: string;
}

export interface ImageDetail {
  image: ImageRow;
  params: string | null;
  keywords: string[];
}

export interface HistoryEntry {
  id: number;
  label: string;
  params: string;
  createdAt: string;
}

export interface Snapshot {
  id: number;
  name: string;
  params: string;
  createdAt: string;
}

export interface Preset {
  id: number;
  group: string;
  name: string;
  params: string;
  description: string;
  favorite: boolean;
  source: 'user' | 'ai';
  createdAt: string;
  updatedAt: string;
}

/** Partial preset update; omitted fields are left unchanged. Id is preserved. */
export interface PresetPatch {
  group?: string;
  name?: string;
  params?: string;
  description?: string;
  favorite?: boolean;
}

export interface ImportProgress {
  phase: 'scanning' | 'metadata' | 'thumbnails';
  done: number;
  total: number;
  message: string;
}

export interface ImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  errors: string[];
  thumbnails: number;
}

export interface ExportSpec {
  path: string;
  format: 'jpeg' | 'png' | 'tiff';
  quality: number;
  bitDepth: 8 | 16;
  width: number;
  height: number;
  colorSpace: 'srgb' | 'p3' | 'prophoto';
  imageId: number;
  includeMetadata: boolean;
  includeLocation: boolean;
  overwrite: boolean;
}

export interface AppInfo {
  dataDir: string;
  cacheDir: string;
  version: string;
}
