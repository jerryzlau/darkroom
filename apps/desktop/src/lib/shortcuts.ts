import { useEffect } from 'react';
import { useDialogs } from '../components/dialogs/dialogState';
import { backend } from '../ipc/backend';
import { useDevelop } from '../state/develop';
import { useLibrary } from '../state/library';
import { toast } from '../state/toast';
import { useUi } from '../state/ui';
import { createVirtualCopy, pasteToSelection, removeFromCatalog } from './imageActions';

export async function startImport() {
  const paths = await backend().pickFolders();
  if (paths?.length) {
    useLibrary.getState().setImportProgress({ phase: 'scanning', done: 0, total: 0, message: 'Starting import' });
    await backend().importPaths(paths);
  }
}

export async function startImportFiles() {
  const paths = await backend().pickFiles();
  if (paths?.length) {
    useLibrary.getState().setImportProgress({ phase: 'scanning', done: 0, total: 0, message: 'Starting import' });
    await backend().importPaths(paths);
  }
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K: command palette (works from text fields too, never over a dialog)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        if (useDialogs.getState().name) return;
        e.preventDefault();
        e.stopPropagation();
        const ui = useUi.getState();
        ui.setPalette(!ui.paletteOpen);
        return;
      }
      if (useUi.getState().paletteOpen) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (useDialogs.getState().name) return;
      const ui = useUi.getState();
      const lib = useLibrary.getState();
      const dev = useDevelop.getState();
      const cmd = e.metaKey || e.ctrlKey;
      const key = e.key;
      const inDevelop = ui.module === 'develop';
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      // ---- with modifiers ----
      if (cmd && e.shiftKey && e.altKey && key.toLowerCase() === 'i') return handled(), void startImportFiles();
      if (cmd && e.shiftKey && key.toLowerCase() === 'i') return handled(), void startImport();
      if (cmd && e.shiftKey && key.toLowerCase() === 'e') return handled(), useDialogs.getState().open('export', { ids: lib.targetIds() });
      if (cmd && e.shiftKey && key.toLowerCase() === 'c') {
        handled();
        if (!dev.source) return toast('Open a photo in Develop to copy its settings', 'warn');
        return useDialogs.getState().open('copySettings');
      }
      if (cmd && e.shiftKey && key.toLowerCase() === 'v') return handled(), void pasteToSelection();
      if (cmd && e.shiftKey && key.toLowerCase() === 'r') {
        handled();
        if (inDevelop && dev.source) dev.resetAll();
        return;
      }
      if (cmd && !e.shiftKey && key.toLowerCase() === 'z') {
        handled();
        if (inDevelop) dev.undo();
        return;
      }
      if (cmd && e.shiftKey && key.toLowerCase() === 'z') {
        handled();
        if (inDevelop) dev.redo();
        return;
      }
      if (cmd && key.toLowerCase() === 'a') {
        handled();
        if (e.shiftKey) lib.selectNone();
        else lib.selectAll();
        return;
      }
      if (cmd && key === "'") {
        handled();
        if (lib.activeId != null) void createVirtualCopy(lib.activeId);
        return;
      }
      if (cmd && key.toLowerCase() === 'n' && inDevelop && dev.imageId != null) {
        handled();
        void backend()
          .createSnapshot(dev.imageId, `Snapshot ${new Date().toLocaleString()}`, JSON.stringify(dev.params))
          .then(() => dev.loadSnapshots())
          .then(() => toast('Snapshot created'));
        return;
      }
      if (cmd && !e.shiftKey && !e.altKey && key.toLowerCase() === 'j') {
        handled();
        if (inDevelop) ui.toggleAi();
        return;
      }
      if (cmd || e.altKey) return;

      // ---- plain keys ----
      switch (key) {
        case 'g':
        case 'G':
          handled();
          ui.setModule('library');
          lib.setView('grid');
          return;
        case 'e':
        case 'E':
          handled();
          ui.setModule('library');
          lib.setView('loupe');
          return;
        case 'd':
        case 'D':
          handled();
          ui.setModule('develop');
          return;
        case 'Tab':
          handled();
          if (ui.leftOpen || ui.rightOpen) useUi.setState({ leftOpen: false, rightOpen: false });
          else useUi.setState({ leftOpen: true, rightOpen: true });
          return;
        case '?':
          handled();
          useDialogs.getState().open('shortcuts');
          return;
        case 'ArrowRight':
        case 'ArrowDown':
          handled();
          lib.moveActive(1, e.shiftKey);
          return;
        case 'ArrowLeft':
        case 'ArrowUp':
          handled();
          lib.moveActive(-1, e.shiftKey);
          return;
        case 'Backspace':
        case 'Delete':
          handled();
          if (inDevelop && dev.tool === 'spots' && dev.activeSpotId) {
            const id = dev.activeSpotId;
            dev.setAndCommit((p) => (p.spots = p.spots.filter((s) => s.id !== id)), 'Delete Spot');
            dev.setActiveSpot(null);
            return;
          }
          if (inDevelop && (dev.tool === 'masks' || dev.tool === 'select') && dev.activeMaskId) {
            const id = dev.activeMaskId;
            dev.setAndCommit((p) => (p.masks = p.masks.filter((m) => m.id !== id)), 'Delete Mask');
            dev.setActiveMask(null);
            dev.setView({ overlayMask: -1 });
            return;
          }
          if (lib.targetIds().length) removeFromCatalog(lib.targetIds());
          return;
      }
      if (/^[0-5]$/.test(key)) return handled(), lib.setRating(Number(key));
      if (key === 'p' || key === 'P') return handled(), lib.setFlag(1);
      if (key === 'x' || key === 'X') return handled(), lib.setFlag(-1);
      if (key === 'u' || key === 'U') return handled(), lib.setFlag(0);
      const labels: Record<string, string> = { '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' };
      if (labels[key]) return handled(), lib.setColorLabel(labels[key]);

      if (!inDevelop && !(ui.module === 'library' && lib.view === 'loupe')) return;
      // ---- develop / loupe keys ----
      switch (key) {
        case 'z':
        case 'Z':
          handled();
          if (dev.view.mode === 'fit') dev.setView({ mode: 'zoom', zoom: 1 });
          else dev.setView({ mode: 'fit' });
          return;
      }
      if (!inDevelop) return;
      switch (key) {
        case '\\':
          handled();
          dev.setView({ before: !dev.view.before });
          return;
        case 'j':
        case 'J':
          handled();
          dev.setView({ showClipping: !dev.view.showClipping });
          return;
        case 'r':
        case 'R':
          handled();
          dev.setTool('crop');
          return;
        case 'm':
        case 'M':
          handled();
          dev.setTool('masks');
          return;
        case 'k':
        case 'K': {
          handled();
          if (dev.tool !== 'masks') dev.setTool('masks');
          return;
        }
        case 'w':
        case 'W':
          handled();
          dev.setTool('wb');
          return;
        case 'o':
        case 'O': {
          handled();
          const i = dev.params.masks.findIndex((m) => m.id === dev.activeMaskId);
          if (i >= 0) dev.setView({ overlayMask: dev.view.overlayMask === i ? -1 : i, overlayInvert: dev.params.masks[i].invert });
          return;
        }
        case 'q':
        case 'Q':
          handled();
          dev.setTool('spots');
          return;
        case 's':
        case 'S':
          handled();
          dev.setTool('select');
          return;
        case '[':
        case ']': {
          handled();
          const k = key === ']' ? 1.15 : 1 / 1.15;
          if (dev.tool === 'spots') {
            const r = Math.min(0.15, Math.max(0.001, dev.spot.r * k));
            dev.setSpot({ r });
            if (dev.activeSpotId) {
              const id = dev.activeSpotId;
              dev.setAndCommit((p) => {
                const s = p.spots.find((x) => x.id === id);
                if (s) s.r = r;
              }, 'Spot Size');
            }
          } else dev.setBrush({ size: Math.min(0.3, Math.max(0.002, dev.brush.size * k)) });
          return;
        }
        case 'Escape':
          handled();
          if (dev.tool !== 'none') dev.setTool(dev.tool);
          return;
        case 'Enter':
          if (dev.tool === 'crop') {
            handled();
            dev.setTool('crop');
          }
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
