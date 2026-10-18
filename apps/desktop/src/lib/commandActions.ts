// Executes command-palette commands (registry in lib/commands.ts): runs actions,
// or navigates to a tool / panel / control and highlights it.
import { useDialogs } from '../components/dialogs/dialogState';
import { backend } from '../ipc/backend';
import { useDevelop } from '../state/develop';
import { useLibrary } from '../state/library';
import { useReveal } from '../state/reveal';
import { toast } from '../state/toast';
import { useUi } from '../state/ui';
import { autoTone, autoWhiteBalance } from './auto';
import type { Command, CommandTarget } from './commands';
import { createVirtualCopy, pasteToSelection, removeFromCatalog } from './imageActions';
import { startImport, startImportFiles } from './shortcuts';

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Polls `fn` once per frame until it returns a value or `ms` elapse. */
async function waitFor<T>(fn: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const end = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() > end) return null;
    await nextFrame();
  }
}

let runToken = 0;

/** Scrolls `el` into view and pulses it. */
function flash(el: HTMLElement) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1300);
}

/** Switches to the module/tool/tab of `t`, opens its section and highlights the control. */
export async function reveal(t: CommandTarget) {
  const token = ++runToken;
  const ui = useUi.getState();
  const lib = useLibrary.getState();
  if (t.module && ui.module !== t.module) ui.setModule(t.module);
  if (t.libView) {
    useUi.getState().setModule('library');
    lib.setView(t.libView);
  }
  if (t.side === 'left' && !useUi.getState().leftOpen) useUi.setState({ leftOpen: true });
  if (t.side === 'right' && !useUi.getState().rightOpen) useUi.setState({ rightOpen: true });

  if (t.needsPhoto) {
    if (!useDevelop.getState().source && lib.activeId == null) {
      toast('Select a photo to edit', 'warn');
      return;
    }
    // Develop opens the active photo (App effect); tools need it loaded first
    const ready = await waitFor(() => {
      const d = useDevelop.getState();
      return d.source != null && !d.loading;
    }, 8000);
    if (token !== runToken) return;
    if (!ready) return;
  }

  if (t.tool && useDevelop.getState().tool !== t.tool) useDevelop.getState().setTool(t.tool);
  if (t.aiTab) {
    useUi.getState().toggleAi(true);
    useUi.getState().setAiTab(t.aiTab);
  }

  let section = t.section;
  let control = t.control;
  if (section === 'colormixer' && useDevelop.getState().params.treatment === 'bw') {
    toast('In B&W the Color Mixer becomes the B&W Mix', 'warn');
    section = 'bwmix';
    control = undefined;
  }
  if (!section) return;
  const sel = `[data-section="${CSS.escape(section)}"]`;
  const sec = await waitFor(() => document.querySelector<HTMLElement>(sel), 1500);
  if (token !== runToken || !sec) return;
  useReveal.getState().request(section, control);
  let el: HTMLElement | null = null;
  if (control) {
    const csel = `[data-ctl="${CSS.escape(control)}"]`;
    el = await waitFor(() => sec.querySelector<HTMLElement>(csel), 500);
    if (token !== runToken) return;
  }
  // a hidden control (e.g. a mask setting with no mask selected) falls back to the section header
  const target = el ?? sec.querySelector<HTMLElement>(':scope > header') ?? sec;
  await nextFrame();
  flash(target);
  const track = el?.querySelector<HTMLElement>('.slider-track');
  if (track && track.tabIndex >= 0) track.focus({ preventScroll: true });
}

function needPhoto(): boolean {
  if (useDevelop.getState().source) return true;
  toast('Select a photo to edit', 'warn');
  return false;
}

function goDevelop(): boolean {
  useUi.getState().setModule('develop');
  if (useLibrary.getState().activeId == null && !useDevelop.getState().source) {
    toast('Select a photo to edit', 'warn');
    return false;
  }
  return true;
}

/** Runs an action command by id. */
export function runAction(id: string) {
  const ui = useUi.getState();
  const lib = useLibrary.getState();
  const dev = useDevelop.getState();
  const dialogs = useDialogs.getState();
  switch (id) {
    case 'action.grid':
      ui.setModule('library');
      return lib.setView('grid');
    case 'action.loupe':
      ui.setModule('library');
      return lib.setView('loupe');
    case 'action.develop':
      return void goDevelop();
    case 'action.prev':
      return lib.moveActive(-1);
    case 'action.next':
      return lib.moveActive(1);
    case 'action.fit':
      if (ui.module === 'library' && lib.view === 'grid') lib.setView('loupe');
      return dev.setView({ mode: 'fit' });
    case 'action.zoom100':
      if (ui.module === 'library' && lib.view === 'grid') lib.setView('loupe');
      return dev.setView({ mode: 'zoom', zoom: 1 });
    case 'action.beforeAfter':
      if (!goDevelop()) return;
      return dev.setView({ before: !dev.view.before });
    case 'action.clipping':
      if (!goDevelop()) return;
      return dev.setView({ showClipping: !dev.view.showClipping });
    case 'action.togglePanels':
      if (ui.leftOpen || ui.rightOpen) useUi.setState({ leftOpen: false, rightOpen: false });
      else useUi.setState({ leftOpen: true, rightOpen: true });
      return;
    case 'action.toggleLeft':
      return ui.toggle('leftOpen');
    case 'action.toggleRight':
      return ui.toggle('rightOpen');
    case 'action.toggleFilmstrip':
      return ui.toggle('filmstripOpen');
    case 'action.toggleAi':
      ui.setModule('develop');
      if (!ui.rightOpen) useUi.setState({ rightOpen: true });
      return ui.toggleAi();
    case 'action.importFolder':
      return void startImport();
    case 'action.importFiles':
      return void startImportFiles();
    case 'action.export':
      return dialogs.open('export', { ids: lib.targetIds() });
    case 'action.settings':
      return dialogs.open('settings');
    case 'action.shortcuts':
      return dialogs.open('shortcuts');
    case 'action.filterLibrary':
      return dialogs.open('filterLibrary', { ids: lib.targetIds() });
    case 'action.undo':
      if (ui.module === 'develop') dev.undo();
      return;
    case 'action.redo':
      if (ui.module === 'develop') dev.redo();
      return;
    case 'action.resetAll':
      if (needPhoto()) dev.resetAll();
      return;
    case 'action.copySettings':
      if (!dev.source) return toast('Open a photo in Develop to copy its settings', 'warn');
      return dialogs.open('copySettings');
    case 'action.pasteSettings':
      return void pasteToSelection();
    case 'action.savePreset':
      if (needPhoto()) dialogs.open('savePreset');
      return;
    case 'action.snapshot': {
      if (!needPhoto() || dev.imageId == null) return;
      void backend()
        .createSnapshot(dev.imageId, `Snapshot ${new Date().toLocaleString()}`, JSON.stringify(dev.params))
        .then(() => useDevelop.getState().loadSnapshots())
        .then(() => toast('Snapshot created'));
      return;
    }
    case 'action.autoTone': {
      if (!needPhoto()) return;
      const a = autoTone(dev.source!, dev.params);
      dev.setAndCommit((q) => Object.assign(q, a), 'Auto Tone');
      return void reveal({ module: 'develop', side: 'right', section: 'basic', control: 'exposure' });
    }
    case 'action.autoWb': {
      if (!needPhoto()) return;
      const t = autoWhiteBalance(dev.source!);
      dev.setAndCommit((q) => (q.wb = { mode: 'custom', ...t }), 'WB: Auto');
      return void reveal({ module: 'develop', side: 'right', section: 'basic', control: 'temp' });
    }
    case 'action.virtualCopy':
      if (lib.activeId == null) return toast('Select a photo first', 'warn');
      return void createVirtualCopy(lib.activeId);
    case 'action.selectAll':
      return lib.selectAll();
    case 'action.pick':
      return lib.setFlag(1);
    case 'action.reject':
      return lib.setFlag(-1);
    case 'action.unflag':
      return lib.setFlag(0);
    case 'action.remove': {
      const ids = lib.targetIds();
      if (!ids.length) return toast('Select a photo first', 'warn');
      return removeFromCatalog(ids);
    }
    default:
      console.warn('unknown command', id);
  }
}

/** Executes a palette command. */
export function runCommand(c: Command) {
  if (c.kind === 'action') return runAction(c.id);
  if (c.target) void reveal(c.target);
}
