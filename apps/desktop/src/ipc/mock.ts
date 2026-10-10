/**
 * In-browser mock backend: synthetic photos and an in-memory catalog, so the
 * UI and renderer can be developed and tested with `pnpm web` (no Tauri).
 */
import { XYZ_TO_SRGB, defaultParams } from '@darkroom/core';
import type { Backend } from './backend';
import type { Collection, Folder, HistoryEntry, ImageRow, ImportProgress, ImportSummary, Preset, Snapshot } from './types';

const FULL_W = 2400;
const FULL_H = 1600;
const PREV_W = 1200;
const PREV_H = 800;

const CHART = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
  [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
  [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
];
const lin = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const hash = (x: number, y: number) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 0xffff) / 65535;
};

interface Variant {
  sunX: number;
  cast: [number, number, number];
  exposure: number;
  raw: boolean;
  portrait: boolean;
  hue: number;
}

const VARIANTS: Variant[] = [
  { sunX: 0.78, cast: [1, 1, 1], exposure: 1, raw: true, portrait: false, hue: 0 },
  { sunX: 0.3, cast: [1.35, 1, 0.62], exposure: 0.7, raw: true, portrait: false, hue: 0.1 },
  { sunX: 0.6, cast: [0.85, 1, 1.25], exposure: 1.4, raw: false, portrait: false, hue: 0.3 },
  { sunX: 0.5, cast: [1, 1, 1], exposure: 0.45, raw: true, portrait: true, hue: 0.5 },
  { sunX: 0.9, cast: [1.1, 1, 0.9], exposure: 1, raw: false, portrait: false, hue: 0.7 },
  { sunX: 0.15, cast: [1, 1.08, 1], exposure: 2.2, raw: true, portrait: false, hue: 0.85 },
];

function scene(x: number, y: number, w: number, h: number, v: Variant): [number, number, number] {
  const fx = x / w;
  const fy = y / h;
  const s = Math.floor(w / 24);
  const cx = Math.floor(w / 20);
  const cy = Math.floor((h * 58) / 100);
  if (x >= cx && y >= cy && x < cx + 6 * s && y < cy + 4 * s) {
    const col = Math.floor((x - cx) / s);
    const row = Math.floor((y - cy) / s);
    const inner = (x - cx) % s > s / 10 && (y - cy) % s > s / 10;
    if (inner) {
      const c = CHART[row * 6 + col];
      return [lin(c[0]), lin(c[1]), lin(c[2])];
    }
    return [0.02, 0.02, 0.02];
  }
  const sx = v.sunX * w;
  const sy = 0.16 * h;
  const d = Math.hypot(x - sx, y - sy) / h;
  const horizon = 0.42 + 0.05 * Math.sin(fx * 7 + v.hue * 6) + 0.02 * Math.sin(fx * 23);
  if (fy < horizon) {
    const t = fy / horizon;
    const sky = [0.05 + 0.4 * t, 0.12 + 0.43 * t, 0.38 + 0.32 * t];
    const glow = 0.6 * Math.exp(-d * 9);
    const sun = d < 0.03 ? 12 : 0;
    return [sky[0] + glow + sun, sky[1] + glow * 0.85 + sun, sky[2] + glow * 0.6 + sun];
  }
  if (fx > 0.62 && fy > 0.6) {
    const stripes = (Math.floor(x / 12) + Math.floor(y / 40)) % 2 === 0 ? 1 : 0.55;
    const ramp = Math.min(1, Math.max(0, (fx - 0.62) / 0.38));
    const val = 0.004 + 0.02 * ramp * stripes;
    return [val * 1.05, val, val * 0.9];
  }
  const n = hash(x >> 2, y >> 2) * 0.6 + hash(Math.floor(x / 17), Math.floor(y / 11)) * 0.4;
  const g = 0.04 + 0.1 * n;
  const hueMix = v.hue;
  return [g * (0.55 + hueMix * 0.6), g, g * (0.3 + hueMix * 0.2)];
}

interface MockPhoto {
  row: ImageRow;
  params: string | null;
  keywords: string[];
}

function makeFull(v: Variant): { data: Uint16Array; w: number; h: number } {
  const w = v.portrait ? FULL_H : FULL_W;
  const h = v.portrait ? FULL_W : FULL_H;
  const data = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = scene(x, y, w, h, v);
      const i = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) {
        let val = c[k] * v.cast[k] * v.exposure;
        if (v.raw) val *= 0.42;
        else val = val / (1 + val * 0.25);
        val += (hash(x * 3 + k, y) - 0.5) * 0.004;
        data[i + k] = Math.max(0, Math.min(65535, Math.round(val * 65535)));
      }
    }
  }
  return { data, w, h };
}

function downscale(src: Uint16Array, w: number, h: number, ow: number, oh: number, x0 = 0, y0 = 0, rw = w, rh = h): Uint16Array {
  const out = new Uint16Array(ow * oh * 3);
  const sx = rw / ow;
  const sy = rh / oh;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const fx0 = x0 + x * sx;
      const fy0 = y0 + y * sy;
      const ix0 = Math.floor(fx0);
      const iy0 = Math.floor(fy0);
      const ix1 = Math.max(ix0 + 1, Math.min(w, Math.ceil(fx0 + sx)));
      const iy1 = Math.max(iy0 + 1, Math.min(h, Math.ceil(fy0 + sy)));
      const acc = [0, 0, 0];
      let n = 0;
      for (let yy = iy0; yy < iy1; yy++)
        for (let xx = ix0; xx < ix1; xx++) {
          const i = (Math.min(h - 1, yy) * w + Math.min(w - 1, xx)) * 3;
          acc[0] += src[i];
          acc[1] += src[i + 1];
          acc[2] += src[i + 2];
          n++;
        }
      const o = (y * ow + x) * 3;
      out[o] = acc[0] / n;
      out[o + 1] = acc[1] / n;
      out[o + 2] = acc[2] / n;
    }
  }
  return out;
}

export function createMockBackend(): Backend {
  let nextId = 1;
  const now = () => new Date().toISOString();
  const folders: Folder[] = [
    { id: 1, path: '/Users/demo/Pictures', name: 'Pictures', parentId: null, count: 0 },
    { id: 2, path: '/Users/demo/Pictures/Iceland', name: 'Iceland', parentId: 1, count: 0 },
    { id: 3, path: '/Users/demo/Pictures/Portraits', name: 'Portraits', parentId: 1, count: 0 },
  ];
  const photos: MockPhoto[] = [];
  const fullCache = new Map<number, { data: Uint16Array; w: number; h: number }>();
  const thumbCache = new Map<number, string>();
  const history = new Map<number, HistoryEntry[]>();
  const snapshots: (Snapshot & { imageId: number })[] = [];
  const presets: Preset[] = [];
  {
    // a demo favorite "filter" (full nested sections: applyPartial replaces whole top-level keys)
    const d = defaultParams();
    const ts = now();
    presets.push({
      id: nextId++,
      group: 'User Presets',
      name: 'Warm Film',
      params: JSON.stringify({
        contrast: 12,
        shadows: 18,
        vibrance: 10,
        grading: { ...d.grading, highlights: { h: 40, s: 20, l: 0 } },
        effects: { ...d.effects, grainAmount: 18, grainSize: 30 },
      }),
      description: 'Warm highlights, lifted shadows, light grain',
      favorite: true,
      source: 'ai',
      createdAt: ts,
      updatedAt: ts,
    });
  }
  const collections: (Collection & { images: Set<number> })[] = [];
  const settings = new Map<string, string>();
  const variantOf = new Map<number, Variant>();

  VARIANTS.concat(VARIANTS).forEach((v, i) => {
    const id = nextId++;
    const raw = v.raw;
    const portrait = v.portrait;
    const folderId = i % 3 === 2 ? 3 : 2;
    const fname = `DSC_${String(1000 + i)}.${raw ? 'NEF' : 'JPG'}`;
    variantOf.set(id, v);
    photos.push({
      row: {
        id,
        photoId: id,
        folderId,
        copyName: null,
        edited: false,
        rating: i % 4 === 0 ? 3 : 0,
        flag: 0,
        colorLabel: i === 4 ? 'red' : '',
        thumbRev: 0,
        thumbOk: true,
        missing: false,
        updatedAt: now(),
        importedAt: now(),
        path: `${folders[folderId - 1].path}/${fname}`,
        filename: fname,
        format: raw ? 'raw' : 'jpeg',
        fileSize: 24_000_000,
        mtime: 0,
        width: portrait ? FULL_H : FULL_W,
        height: portrait ? FULL_W : FULL_H,
        capturedAt: `2024-06-0${(i % 9) + 1}T1${i % 10}:30:00`,
        make: 'Nikon',
        model: 'Z 8',
        lens: 'NIKKOR Z 24-70mm f/2.8 S',
        focalLength: 24 + i * 4,
        fnumber: 2.8 + (i % 3),
        exposureTime: `1/${125 * (1 + (i % 4))}`,
        iso: 100 * (1 + (i % 5)),
        gpsLat: null,
        gpsLon: null,
      },
      params: null,
      keywords: i % 2 ? ['landscape'] : ['test'],
    });
  });

  const full = (photoId: number) => {
    let f = fullCache.get(photoId);
    if (!f) {
      f = makeFull(variantOf.get(photoId) ?? VARIANTS[0]);
      fullCache.set(photoId, f);
    }
    return f;
  };

  const thumb = (photoId: number) => {
    let t = thumbCache.get(photoId);
    if (t) return t;
    const v = variantOf.get(photoId) ?? VARIANTS[0];
    const w = v.portrait ? 160 : 240;
    const h = v.portrait ? 240 : 160;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = scene(Math.floor((x * (v.portrait ? FULL_H : FULL_W)) / w), Math.floor((y * (v.portrait ? FULL_W : FULL_H)) / h), v.portrait ? FULL_H : FULL_W, v.portrait ? FULL_W : FULL_H, v);
        const i = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) {
          let val = s[k] * v.cast[k] * v.exposure * (v.raw ? 0.9 : 1);
          val = val / (1 + val * 0.25);
          img.data[i + k] = Math.round(Math.pow(Math.min(1, Math.max(0, val)), 1 / 2.2) * 255);
        }
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    t = c.toDataURL('image/jpeg', 0.85);
    thumbCache.set(photoId, t);
    return t;
  };

  const editThumbs = new Map<number, string>();
  const find = (id: number) => {
    const p = photos.find((x) => x.row.id === id);
    if (!p) throw new Error(`image ${id} not found`);
    return p;
  };
  const listeners = { progress: new Set<(p: ImportProgress) => void>(), done: new Set<(s: ImportSummary) => void>() };
  const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 0));

  const b: Backend = {
    kind: 'mock',
    listFolders: async () =>
      folders.map((f) => ({ ...f, count: photos.filter((p) => p.row.folderId === f.id).length })),
    listCollections: async () => collections.map(({ images, ...c }) => ({ ...c, count: images.size })),
    listImages: async (q) => {
      let rows = photos.map((p) => p.row);
      if (q.source === 'folder' && q.sourceId != null) {
        const ids = new Set([q.sourceId]);
        if (q.recursive !== false) folders.filter((f) => f.parentId === q.sourceId).forEach((f) => ids.add(f.id));
        rows = rows.filter((r) => ids.has(r.folderId));
      } else if (q.source === 'collection' && q.sourceId != null) {
        const c = collections.find((c) => c.id === q.sourceId);
        rows = rows.filter((r) => c?.images.has(r.id));
      }
      if (q.minRating) rows = rows.filter((r) => (q.ratingOp === '=' ? r.rating === q.minRating : q.ratingOp === '<=' ? r.rating <= q.minRating! : r.rating >= q.minRating!));
      if (q.flag === 'picked') rows = rows.filter((r) => r.flag === 1);
      if (q.flag === 'rejected') rows = rows.filter((r) => r.flag === -1);
      if (q.flag === 'unflagged') rows = rows.filter((r) => r.flag === 0);
      if (q.flag === 'notRejected') rows = rows.filter((r) => r.flag !== -1);
      if (q.colorLabel) rows = rows.filter((r) => (q.colorLabel === 'none' ? !r.colorLabel : r.colorLabel === q.colorLabel));
      if (q.text) rows = rows.filter((r) => r.filename.toLowerCase().includes(q.text!.toLowerCase()));
      if (q.edited != null) rows = rows.filter((r) => r.edited === q.edited);
      const key = q.sort ?? 'captured';
      rows = [...rows].sort((a, b) => {
        const va = key === 'filename' ? a.filename : key === 'rating' ? a.rating : key === 'edited' ? a.updatedAt : a.capturedAt ?? '';
        const vb = key === 'filename' ? b.filename : key === 'rating' ? b.rating : key === 'edited' ? b.updatedAt : b.capturedAt ?? '';
        return (va < vb ? -1 : va > vb ? 1 : a.id - b.id) * (q.desc ? -1 : 1);
      });
      return delay(rows.map((r) => ({ ...r })));
    },
    getImage: async (id) => {
      const p = find(id);
      return { image: { ...p.row }, params: p.params, keywords: [...p.keywords] };
    },
    saveParams: async (imageId, params, edited, label, truncateAfter) => {
      const p = find(imageId);
      p.params = params;
      p.row.edited = edited;
      p.row.updatedAt = now();
      const h = history.get(imageId) ?? [];
      if (truncateAfter != null) {
        const idx = h.findIndex((e) => e.id === truncateAfter);
        if (idx >= 0) h.splice(idx + 1);
      }
      if (!label) {
        history.set(imageId, h);
        return null;
      }
      const e = { id: nextId++, label, params, createdAt: now() };
      h.push(e);
      history.set(imageId, h);
      return e;
    },
    listHistory: async (imageId) => [...(history.get(imageId) ?? [])],
    clearHistory: async (imageId) => {
      history.set(imageId, []);
    },
    listSnapshots: async (imageId) => snapshots.filter((s) => s.imageId === imageId),
    createSnapshot: async (imageId, name, params) => {
      const id = nextId++;
      snapshots.push({ id, imageId, name, params, createdAt: now() });
      return id;
    },
    deleteSnapshot: async (id) => {
      const i = snapshots.findIndex((s) => s.id === id);
      if (i >= 0) snapshots.splice(i, 1);
    },
    listPresets: async () => [...presets],
    savePreset: async (group, name, params, description = '', source = 'user') => {
      const ts = now();
      const existing = presets.find((p) => p.group === group && p.name === name);
      if (existing) {
        Object.assign(existing, { params, description, source, updatedAt: ts });
        return existing.id;
      }
      const id = nextId++;
      presets.push({ id, group, name, params, description, favorite: false, source, createdAt: ts, updatedAt: ts });
      return id;
    },
    updatePreset: async (id, patch) => {
      const p = presets.find((x) => x.id === id);
      if (!p) throw new Error(`preset ${id} not found`);
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) Object.assign(p, { [k]: v });
      p.updatedAt = now();
    },
    deletePreset: async (id) => {
      const i = presets.findIndex((p) => p.id === id);
      if (i >= 0) presets.splice(i, 1);
    },
    createCollection: async (name, kind, rules) => {
      const id = nextId++;
      collections.push({ id, name, kind, rules, count: 0, images: new Set() });
      return id;
    },
    updateCollection: async (id, name, rules) => {
      const c = collections.find((c) => c.id === id);
      if (c) {
        c.name = name;
        if (rules) c.rules = rules;
      }
    },
    deleteCollection: async (id) => {
      const i = collections.findIndex((c) => c.id === id);
      if (i >= 0) collections.splice(i, 1);
    },
    addToCollection: async (id, ids) => {
      const c = collections.find((c) => c.id === id);
      ids.forEach((i) => c?.images.add(i));
    },
    removeFromCollection: async (id, ids) => {
      const c = collections.find((c) => c.id === id);
      ids.forEach((i) => c?.images.delete(i));
    },
    setRating: async (ids, rating) => ids.forEach((id) => (find(id).row.rating = rating)),
    setFlag: async (ids, flag) => ids.forEach((id) => (find(id).row.flag = flag)),
    setColorLabel: async (ids, label) => ids.forEach((id) => (find(id).row.colorLabel = label)),
    getKeywords: async (photoId) => [...find(photoId).keywords],
    allKeywords: async () => {
      const m = new Map<string, number>();
      photos.forEach((p) => p.keywords.forEach((k) => m.set(k, (m.get(k) ?? 0) + 1)));
      return [...m.entries()].sort();
    },
    addKeywords: async (photoIds, names) =>
      photoIds.forEach((id) => {
        const p = find(id);
        names.forEach((n) => !p.keywords.includes(n) && p.keywords.push(n));
      }),
    removeKeyword: async (photoIds, name) =>
      photoIds.forEach((id) => {
        const p = find(id);
        p.keywords = p.keywords.filter((k) => k !== name);
      }),
    createVirtualCopy: async (imageId) => {
      const p = find(imageId);
      const id = nextId++;
      variantOf.set(id, variantOf.get(p.row.photoId)!);
      photos.push({ row: { ...p.row, id, copyName: 'Copy 1' }, params: p.params, keywords: [...p.keywords] });
      return id;
    },
    removeImages: async (ids) => {
      for (const id of ids) {
        const i = photos.findIndex((p) => p.row.id === id);
        if (i >= 0) photos.splice(i, 1);
      }
    },
    removeFolder: async () => {},
    importPaths: async () => {
      const total = 3;
      for (let i = 0; i <= total; i++) {
        await new Promise((r) => setTimeout(r, 150));
        listeners.progress.forEach((cb) => cb({ phase: 'thumbnails', done: i, total, message: '' }));
      }
      listeners.done.forEach((cb) => cb({ added: 0, updated: 0, unchanged: photos.length, missing: 0, errors: [], thumbnails: 0 }));
    },
    rescanFolder: async () => {},
    getSetting: async (k) => settings.get(k) ?? null,
    setSetting: async (k, v) => {
      settings.set(k, v);
    },
    writeSidecars: async (ids) => ids.length,
    revealInFinder: async () => {},
    appInfo: async () => ({ dataDir: '(browser mock)', cacheDir: '(browser mock)', version: '0.1.0' }),
    log: (level, message) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[backend]', message),
    getPreview: async (photoId) => {
      const v = variantOf.get(photoId) ?? VARIANTS[0];
      const f = full(photoId);
      const pw = v.portrait ? PREV_H : PREV_W;
      const ph = v.portrait ? PREV_W : PREV_H;
      const data = downscale(f.data, f.w, f.h, pw, ph);
      const cast = v.cast;
      const info = {
        photoId,
        width: f.w,
        height: f.h,
        previewWidth: pw,
        previewHeight: ph,
        color: {
          isRaw: v.raw,
          xyzToCam: XYZ_TO_SRGB,
          asShotMul: v.raw ? [1 / cast[0] / (1 / cast[1]), 1, 1 / cast[2] / (1 / cast[1])] : [1, 1, 1],
          space: 'srgb',
        },
      };
      const json = new TextEncoder().encode(JSON.stringify(info));
      const pad = (4 - ((4 + json.length) % 4)) % 4;
      const buf = new ArrayBuffer(4 + json.length + pad + data.byteLength);
      new DataView(buf).setUint32(0, json.length + pad, true);
      new Uint8Array(buf, 4, json.length).set(json);
      new Uint8Array(buf, 4 + json.length, pad).fill(32);
      new Uint16Array(buf, 4 + json.length + pad).set(data);
      return buf;
    },
    getRegion: async (photoId, x, y, w, h, ow, oh) => {
      const f = full(photoId);
      const data = downscale(f.data, f.w, f.h, ow, oh, x, y, w, h);
      const buf = new ArrayBuffer(8 + data.byteLength);
      const dv = new DataView(buf);
      dv.setUint32(0, ow, true);
      dv.setUint32(4, oh, true);
      new Uint16Array(buf, 8).set(data);
      return buf;
    },
    saveEditThumb: async (imageId, jpeg) => {
      const blob = new Blob([jpeg as BlobPart], { type: 'image/jpeg' });
      const old = editThumbs.get(imageId);
      if (old) URL.revokeObjectURL(old);
      editThumbs.set(imageId, URL.createObjectURL(blob));
      const p = find(imageId);
      p.row.thumbRev += 1;
      return p.row.thumbRev;
    },
    resetEditThumb: async (imageId) => {
      editThumbs.delete(imageId);
      find(imageId).row.thumbRev = 0;
    },
    exportBegin: async () => nextId++,
    exportTile: async () => {},
    exportFinish: async () => '/Users/demo/Exports/export.jpg',
    exportCancel: async () => {},
    thumbUrl: (imageId, rev) => (rev > 0 && editThumbs.get(imageId)) || thumb(photos.find((p) => p.row.id === imageId)?.row.photoId ?? imageId),
    pickFolders: async () => ['/Users/demo/Pictures/New'],
    pickFiles: async () => null,
    pickExportFolder: async () => '/Users/demo/Exports',
    onImportProgress: (cb) => {
      listeners.progress.add(cb);
      return () => listeners.progress.delete(cb);
    },
    onImportDone: (cb) => {
      listeners.done.add(cb);
      return () => listeners.done.delete(cb);
    },
  };
  return b;
}
