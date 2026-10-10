import { SECTIONS, type PartialParams, type SectionName } from '@darkroom/core';
import { confirmDialog } from '../components/dialogs/dialogState';
import { backend } from '../ipc/backend';
import type { Preset } from '../ipc/types';
import { applyToImages, useDevelop } from '../state/develop';
import { useLibrary } from '../state/library';
import { toast } from '../state/toast';
import { refreshThumbnails } from './background';

/**
 * Apply a preset/filter to `ids` (default: the library selection). The open photo goes through
 * the develop store so its history and on-screen state stay in sync; the rest are written directly.
 */
export async function applyPresetToSelection(name: string, params: PartialParams, ids = useLibrary.getState().targetIds()): Promise<number> {
  if (!ids.length) {
    toast('No photos selected', 'warn');
    return 0;
  }
  const dev = useDevelop.getState();
  const openId = dev.imageId;
  let n = 0;
  if (openId != null && ids.includes(openId)) {
    dev.applyPreset(params, name);
    n++;
  }
  const others = ids.filter((i) => i !== openId);
  if (others.length) {
    n += await applyToImages(others, params, `Preset: ${name}`);
    void refreshThumbnails(others);
  }
  toast(`Applied “${name}” to ${n} photo${n === 1 ? '' : 's'}`);
  return n;
}

export async function toggleFavorite(p: Preset): Promise<void> {
  await backend().updatePreset(p.id, { favorite: !p.favorite });
  await useDevelop.getState().loadPresets();
}

/** `then` runs after the dialog closes either way (e.g. to reopen the dialog that asked). */
export function deletePresetConfirmed(p: Preset, then?: () => void): void {
  confirmDialog({
    title: 'Delete filter',
    message: `Delete “${p.name}”? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      try {
        await backend().deletePreset(p.id);
        await useDevelop.getState().loadPresets();
      } finally {
        then?.();
      }
    },
    onCancel: then,
  });
}

/** Sections whose fields appear in `params`. */
export function presetSections(params: PartialParams): SectionName[] {
  return (Object.keys(SECTIONS) as SectionName[]).filter((s) => (SECTIONS[s] as readonly string[]).some((k) => k in params));
}

export function parsePresetParams(p: Preset): PartialParams | null {
  try {
    const v = JSON.parse(p.params);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as PartialParams) : null;
  } catch {
    return null;
  }
}
