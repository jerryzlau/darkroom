/**
 * Off-screen rendering with its own WebGL context: full-resolution export
 * (tiled, through the exact same pipeline as the screen) and thumbnails for
 * images edited without being opened (presets / paste on a selection).
 */
import { asShotTempTint, defaultParams, frameDims, normalizeParams, type EditParams, type OutputSpace } from '@darkroom/core';
import { cropUvToSource, Engine, expandForSpots } from '../engine/Engine';
import { parsePreview, parseRegion, type LoadedSource } from '../engine/source';
import { backend } from '../ipc/backend';
import type { ExportSpec, ImageRow } from '../ipc/types';
import { useLibrary } from '../state/library';
import { ensurePatchAssets } from './patchAssets';

let bg: Engine | null = null;
const sources = new Map<number, LoadedSource>();

/** The background engine holds one photo at a time: jobs take turns. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function engine(): Engine {
  if (!bg) {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    bg = new Engine(c);
  }
  return bg;
}

async function loadSource(photoId: number): Promise<LoadedSource> {
  let s = sources.get(photoId);
  if (!s) {
    s = parsePreview(await backend().getPreview(photoId));
    sources.clear();
    sources.set(photoId, s);
  }
  return s;
}

async function prepare(imageId: number): Promise<{ row: ImageRow; src: LoadedSource; params: EditParams; base: EditParams }> {
  const d = await backend().getImage(imageId);
  const src = await loadSource(d.image.photoId);
  const shot = asShotTempTint(src.color);
  const base = defaultParams({ isRaw: src.color.isRaw, asShotTemp: shot.temp, asShotTint: shot.tint });
  const params = d.params ? normalizeParams(JSON.parse(d.params), base) : base;
  const e = engine();
  if (e.source !== src) e.setSource(src);
  e.setParams(params, base);
  await ensurePatchAssets(params, e);
  return { row: d.image, src, params, base };
}

async function encodePixels(px: Uint8Array, w: number, h: number, type: string, quality?: number): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(px);
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, quality));
  if (!blob) throw new Error(`${type} encode failed`);
  return new Uint8Array(await blob.arrayBuffer());
}

export function toJpeg(px: Uint8Array, w: number, h: number, quality = 0.85): Promise<Uint8Array> {
  return encodePixels(px, w, h, 'image/jpeg', quality);
}

export function toPng(px: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  return encodePixels(px, w, h, 'image/png');
}

export async function refreshThumbnails(ids: number[]) {
  for (const id of ids) {
    try {
      await exclusive(async () => {
      const { src, params } = await prepare(id);
      const g = params.geometry;
      const f = frameDims({ w: src.info.width, h: src.info.height }, g.rotate);
      const ar = (g.crop.w * f.w) / (g.crop.h * f.h);
      const w = ar >= 1 ? 640 : Math.round(640 * ar);
      const h = ar >= 1 ? Math.round(640 / ar) : 640;
      const px = engine().renderSmall(w, h);
      if (!px) return;
      const rev = await backend().saveEditThumb(id, await toJpeg(px, w, h));
      useLibrary.getState().patchImage(id, { thumbRev: rev });
      });
    } catch (e) {
      backend().log('warn', `thumbnail ${id}: ${e}`);
    }
  }
}

export interface ExportSettings {
  folder: string;
  template: string;
  format: 'jpeg' | 'png' | 'tiff';
  quality: number;
  bitDepth: 8 | 16;
  colorSpace: OutputSpace;
  resize: boolean;
  longEdge: number;
  includeMetadata: boolean;
  includeLocation: boolean;
  overwrite: boolean;
}

export const defaultExportSettings = (): ExportSettings => ({
  folder: '',
  template: '{name}',
  format: 'jpeg',
  quality: 90,
  bitDepth: 8,
  colorSpace: 'srgb',
  resize: false,
  longEdge: 2048,
  includeMetadata: true,
  includeLocation: false,
  overwrite: false,
});

export function fileName(row: ImageRow, template: string, seq: number, ext: string) {
  const base = row.filename.replace(/\.[^.]+$/, '');
  const date = (row.capturedAt ?? '').slice(0, 10);
  let name = (template || '{name}')
    .replaceAll('{name}', base)
    .replaceAll('{seq}', String(seq).padStart(3, '0'))
    .replaceAll('{date}', date)
    .replaceAll('{rating}', String(row.rating));
  if (row.copyName) name += `-${row.copyName.replace(/\s+/g, '')}`;
  name = name.replace(/[/\\:]/g, '-').trim() || base;
  return `${name}.${ext}`;
}

const TILE = 1024;

export interface ExportProgress {
  index: number;
  total: number;
  fraction: number;
  file: string;
}

/** Export images; returns written paths. Throws on the first failure unless `continueOnError`. */
export async function exportImages(
  ids: number[],
  s: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean,
): Promise<{ written: string[]; errors: string[] }> {
  const written: string[] = [];
  const errors: string[] = [];
  const b = backend();
  const e = engine();
  const used = new Set<string>();
  for (let n = 0; n < ids.length; n++) {
    if (isCancelled()) break;
    const id = ids[n];
    let job: number | null = null;
    try {
      await exclusive(async () => {
      const { row, src, params } = await prepare(id);
      const info = src.info;
      const g = params.geometry;
      const f = frameDims({ w: info.width, h: info.height }, g.rotate);
      const cropW = Math.max(1, Math.round(g.crop.w * f.w));
      const cropH = Math.max(1, Math.round(g.crop.h * f.h));
      const k = s.resize ? Math.min(1, s.longEdge / Math.max(cropW, cropH)) : 1;
      const outW = Math.max(1, Math.round(cropW * k));
      const outH = Math.max(1, Math.round(cropH * k));
      const ext = s.format === 'jpeg' ? 'jpg' : s.format === 'png' ? 'png' : 'tif';
      // two originals can share a base name (IMG_1.CR2 + IMG_1.JPG): keep names unique within a batch
      let file = fileName(row, s.template, n + 1, ext);
      for (let k = 2; used.has(file.toLowerCase()); k++) file = fileName(row, s.template, n + 1, ext).replace(/(\.[^.]+)$/, `-${k}$1`);
      used.add(file.toLowerCase());
      const bitDepth: 8 | 16 = s.format === 'jpeg' ? 8 : s.bitDepth;
      const spec: ExportSpec = {
        path: `${s.folder.replace(/\/$/, '')}/${file}`,
        format: s.format,
        quality: s.quality,
        bitDepth,
        width: outW,
        height: outH,
        colorSpace: s.colorSpace,
        imageId: id,
        includeMetadata: s.includeMetadata,
        includeLocation: s.includeLocation,
        overwrite: s.overwrite,
      };
      job = await b.exportBegin(spec);
      const tilesX = Math.ceil(outW / TILE);
      const tilesY = Math.ceil(outH / TILE);
      const long = Math.max(info.width, info.height);
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          if (isCancelled()) throw new Error('cancelled');
          const x0 = tx * TILE;
          const y0 = ty * TILE;
          const tw = Math.min(TILE, outW - x0);
          const th = Math.min(TILE, outH - y0);
          // source footprint of this tile
          const pts: [number, number][] = [];
          for (const u of [x0 / outW, (x0 + tw / 2) / outW, (x0 + tw) / outW])
            for (const v of [y0 / outH, (y0 + th / 2) / outH, (y0 + th) / outH]) pts.push(cropUvToSource(g, info, u, v));
          const distPad = Math.abs(params.lens.distortion) / 100 * 0.2 + (Math.abs(params.lens.caRed) + Math.abs(params.lens.caBlue)) / 100 * 0.006;
          const padPx = 48 / k + 0.005 * long;
          let [rx0, ry0, rx1, ry1] = expandForSpots(
            [
              Math.min(...pts.map((p) => p[0])) - padPx / info.width - distPad,
              Math.min(...pts.map((p) => p[1])) - padPx / info.height - distPad,
              Math.max(...pts.map((p) => p[0])) + padPx / info.width + distPad,
              Math.max(...pts.map((p) => p[1])) + padPx / info.height + distPad,
            ],
            params,
            info,
          );
          rx0 = Math.max(0, rx0);
          ry0 = Math.max(0, ry0);
          rx1 = Math.min(1, rx1);
          ry1 = Math.min(1, ry1);
          const ow = Math.max(1, Math.min(e.maxTextureSize, Math.ceil((rx1 - rx0) * info.width * k)));
          const oh = Math.max(1, Math.min(e.maxTextureSize, Math.ceil((ry1 - ry0) * info.height * k)));
          const buf = await b.getRegion(row.photoId, rx0 * info.width, ry0 * info.height, (rx1 - rx0) * info.width, (ry1 - ry0) * info.height, ow, oh);
          const r = parseRegion(buf);
          const px = e.renderTile(params, { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0, ow: r.w, oh: r.h, data: r.data }, { width: outW, height: outH, tx: x0, ty: y0, tw, th, space: s.colorSpace, bitDepth });
          await b.exportTile(job, x0, y0, tw, th, px);
          onProgress({ index: n, total: ids.length, fraction: (ty * tilesX + tx + 1) / (tilesX * tilesY), file });
        }
      }
      const path = await b.exportFinish(job);
      job = null;
      written.push(path);
      });
    } catch (err) {
      if (job != null) await b.exportCancel(job).catch(() => {});
      if (String(err).includes('cancelled')) break;
      errors.push(String(err));
      backend().log('error', `export ${id}: ${err}`);
    }
  }
  e.releaseTilePipe();
  return { written, errors };
}
