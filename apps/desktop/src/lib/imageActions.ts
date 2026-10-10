import { applyToImages, useDevelop } from '../state/develop';
import { backend } from '../ipc/backend';
import { refreshThumbnails } from './background';
import { useLibrary } from '../state/library';
import { toast } from '../state/toast';
import { useUi } from '../state/ui';
import { confirmDialog, useDialogs } from '../components/dialogs/dialogState';
import type { MenuItem } from '../components/ui';

export function openInDevelop(id: number) {
  useLibrary.getState().select(id);
  useUi.getState().setModule('develop');
}

export async function createVirtualCopy(id: number) {
  const nid = await backend().createVirtualCopy(id);
  await useLibrary.getState().refresh();
  useLibrary.getState().select(nid);
  toast('Created virtual copy');
  return nid;
}

export async function pasteToSelection() {
  const clip = useDevelop.getState().clipboard;
  if (!clip) return toast('Nothing to paste. Copy settings first (⇧⌘C).', 'warn');
  const ids = useLibrary.getState().targetIds();
  const openId = useDevelop.getState().imageId;
  const others = ids.filter((i) => i !== openId);
  if (openId != null && ids.includes(openId)) useDevelop.getState().paste();
  if (others.length) {
    const n = await applyToImages(others, clip.params, 'Paste Settings');
    toast(`Pasted settings to ${n} photo${n === 1 ? '' : 's'}`);
    void refreshThumbnails(others);
  }
}

export function removeFromCatalog(ids: number[]) {
  const rows = useLibrary.getState().images.filter((i) => ids.includes(i.id));
  const copies = rows.filter((r) => r.copyName).length;
  const masters = rows.length - copies;
  confirmDialog({
    title: 'Remove from catalog',
    message:
      `Remove ${rows.length} photo${rows.length === 1 ? '' : 's'} from the catalog?` +
      (masters ? ' Removing an original also removes its virtual copies.' : '') +
      ' Files on disk are not deleted.',
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: async () => {
      await backend().removeImages(ids);
      if (ids.includes(useDevelop.getState().imageId ?? -1)) useDevelop.getState().close();
      await useLibrary.getState().refresh();
    },
  });
}

export function imageMenu(id: number): MenuItem[] {
  const lib = useLibrary.getState();
  const ids = lib.selected.has(id) ? lib.targetIds() : [id];
  const row = lib.images.find((i) => i.id === id);
  return [
    { label: 'Open in Develop', shortcut: 'D', onClick: () => openInDevelop(id) },
    { separator: true, label: '' },
    ...[5, 4, 3, 2, 1, 0].map((r) => ({ label: r ? `${'★'.repeat(r)}` : 'No rating', shortcut: String(r), onClick: () => lib.setRating(r, ids) })),
    { separator: true, label: '' },
    { label: 'Pick', shortcut: 'P', onClick: () => lib.setFlag(1, ids) },
    { label: 'Reject', shortcut: 'X', onClick: () => lib.setFlag(-1, ids) },
    { label: 'Unflag', shortcut: 'U', onClick: () => lib.setFlag(0, ids) },
    { separator: true, label: '' },
    { label: 'Create virtual copy', shortcut: "⌘'", onClick: () => void createVirtualCopy(id) },
    { label: 'Paste settings', shortcut: '⇧⌘V', disabled: !useDevelop.getState().clipboard, onClick: () => void pasteToSelection() },
    { label: 'Apply filter…', onClick: () => useDialogs.getState().open('filterLibrary', { ids }) },
    { label: 'Export…', shortcut: '⇧⌘E', onClick: () => useDialogs.getState().open('export', { ids }) },
    {
      label: 'Save metadata to file (XMP)',
      onClick: async () => {
        const n = await backend().writeSidecars(ids);
        toast(`Wrote ${n} sidecar${n === 1 ? '' : 's'}`);
      },
    },
    { label: 'Show in Finder', disabled: !row, onClick: () => row && backend().revealInFinder(row.path) },
    { separator: true, label: '' },
    { label: 'Remove from catalog…', danger: true, onClick: () => removeFromCatalog(ids) },
  ];
}
