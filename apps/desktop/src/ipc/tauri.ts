import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type { Backend } from './backend';
import type { ImportProgress, ImportSummary } from './types';

export async function createTauriBackend(): Promise<Backend> {
  const off = (p: Promise<() => void>) => () => {
    p.then((f) => f());
  };
  const b: Backend = {
    kind: 'tauri',
    listFolders: () => invoke('list_folders'),
    listCollections: () => invoke('list_collections'),
    listImages: (query) => invoke('list_images', { query }),
    getImage: (id) => invoke('get_image', { id }),
    saveParams: (imageId, params, edited, label, truncateAfter) =>
      invoke('save_params', { imageId, params, edited, label, truncateAfter }),
    listHistory: (imageId) => invoke('list_history', { imageId }),
    clearHistory: (imageId) => invoke('clear_history', { imageId }),
    listSnapshots: (imageId) => invoke('list_snapshots', { imageId }),
    createSnapshot: (imageId, name, params) => invoke('create_snapshot', { imageId, name, params }),
    deleteSnapshot: (id) => invoke('delete_snapshot', { id }),
    listPresets: () => invoke('list_presets'),
    savePreset: (group, name, params, description, source) =>
      invoke('save_preset', { group, name, params, description, source }),
    updatePreset: (id, patch) => invoke('update_preset', { id, patch }),
    deletePreset: (id) => invoke('delete_preset', { id }),
    createCollection: (name, kind, rules) => invoke('create_collection', { name, kind, rules }),
    updateCollection: (id, name, rules) => invoke('update_collection', { id, name, rules }),
    deleteCollection: (id) => invoke('delete_collection', { id }),
    addToCollection: (id, imageIds) => invoke('add_to_collection', { id, imageIds }),
    removeFromCollection: (id, imageIds) => invoke('remove_from_collection', { id, imageIds }),
    setRating: (ids, rating) => invoke('set_rating', { ids, rating }),
    setFlag: (ids, flag) => invoke('set_flag', { ids, flag }),
    setColorLabel: (ids, label) => invoke('set_color_label', { ids, label }),
    getKeywords: (photoId) => invoke('get_keywords', { photoId }),
    allKeywords: () => invoke('all_keywords'),
    addKeywords: (photoIds, names) => invoke('add_keywords', { photoIds, names }),
    removeKeyword: (photoIds, name) => invoke('remove_keyword', { photoIds, name }),
    createVirtualCopy: (imageId) => invoke('create_virtual_copy', { imageId }),
    removeImages: (imageIds) => invoke('remove_images', { imageIds }),
    removeFolder: (id) => invoke('remove_folder', { id }),
    importPaths: (paths) => invoke('import_paths', { paths }),
    rescanFolder: (id) => invoke('rescan_folder', { id }),
    getSetting: (key) => invoke('get_setting', { key }),
    setSetting: (key, value) => invoke('set_setting', { key, value }),
    writeSidecars: (imageIds) => invoke('write_sidecars', { imageIds }),
    revealInFinder: (path) => invoke('reveal_in_finder', { path }),
    appInfo: () => invoke('app_info'),
    log: (level, message) => {
      invoke('log_frontend', { level, message }).catch(() => {});
    },
    getPreview: (photoId) => invoke<ArrayBuffer>('get_preview', { photoId }),
    getRegion: (photoId, x, y, w, h, ow, oh) => invoke<ArrayBuffer>('get_region', { photoId, x, y, w, h, ow, oh }),
    saveEditThumb: (imageId, jpeg) => invoke('save_edit_thumb', jpeg, { headers: { 'x-image-id': String(imageId) } }),
    resetEditThumb: (imageId) => invoke('reset_edit_thumb', { imageId }),
    savePatch: (png) => invoke<string>('save_patch', png),
    getPatch: (hash) => invoke<ArrayBuffer>('get_patch', { hash }),
    exportBegin: (spec) => invoke('export_begin', { spec }),
    exportTile: (job, x, y, w, h, data) =>
      invoke('export_tile', data, {
        headers: { 'x-job': String(job), 'x-x': String(x), 'x-y': String(y), 'x-w': String(w), 'x-h': String(h) },
      }),
    exportFinish: (job) => invoke('export_finish', { jobId: job }),
    exportCancel: (job) => invoke('export_cancel', { jobId: job }),
    thumbUrl: (imageId, rev) => `${convertFileSrc(String(imageId), 'thumb')}?rev=${rev}`,
    pickFolders: async (title) => {
      const r = await open({ directory: true, multiple: true, title: title ?? 'Choose folders to import' });
      if (!r) return null;
      return Array.isArray(r) ? r : [r];
    },
    pickFiles: async () => {
      const r = await open({
        multiple: true,
        title: 'Choose photos to import',
        filters: [
          {
            name: 'Images',
            extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'heic', 'heif', 'webp', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'srw', 'erf', 'kdc', 'mrw', 'iiq', '3fr', 'mef', 'mos', 'x3f'],
          },
        ],
      });
      if (!r) return null;
      return Array.isArray(r) ? r : [r];
    },
    pickExportFolder: async () => {
      const r = await open({ directory: true, multiple: false, title: 'Export to folder' });
      return typeof r === 'string' ? r : null;
    },
    onImportProgress: (cb) => off(listen<ImportProgress>('import:progress', (e) => cb(e.payload))),
    onImportDone: (cb) => off(listen<ImportSummary>('import:done', (e) => cb(e.payload))),
  };
  return b;
}
