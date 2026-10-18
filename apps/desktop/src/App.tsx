import { useEffect } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { DevelopCanvas } from './components/DevelopCanvas';
import { DialogHost } from './components/dialogs/Dialogs';
import { useDialogs } from './components/dialogs/dialogState';
import { AiDock } from './components/develop/AiChat';
import { HistoryPanel, Navigator, PresetsPanel, SnapshotsPanel } from './components/develop/LeftPanels';
import { DevelopRight } from './components/develop/RightPanel';
import { Filmstrip } from './components/library/Filmstrip';
import { FilterBar } from './components/library/FilterBar';
import { Grid } from './components/library/Grid';
import { LibraryLeft } from './components/library/LibraryLeft';
import { MetadataPanel } from './components/library/MetadataPanel';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { Seg } from './components/ui';
import { pasteToSelection } from './lib/imageActions';
import { useShortcuts } from './lib/shortcuts';
import { backend } from './ipc/backend';
import type { SortKey } from './ipc/types';
import { useDevelop } from './state/develop';
import { useLibrary } from './state/library';
import { useUi } from './state/ui';

export function App() {
  const module = useUi((s) => s.module);
  const leftOpen = useUi((s) => s.leftOpen);
  const rightOpen = useUi((s) => s.rightOpen);
  const filmstripOpen = useUi((s) => s.filmstripOpen);
  const libView = useLibrary((s) => s.view);
  const activeId = useLibrary((s) => s.activeId);
  useShortcuts();

  useEffect(() => {
    void useLibrary.getState().refresh();
    const b = backend();
    const offP = b.onImportProgress((p) => useLibrary.getState().setImportProgress(p));
    const offD = b.onImportDone((s) => useLibrary.getState().importDone(s));
    return () => {
      offP();
      offD();
    };
  }, []);

  // the develop engine follows the active photo while it is on screen
  const showsCanvas = module === 'develop' || libView === 'loupe';
  useEffect(() => {
    if (showsCanvas && activeId != null) void useDevelop.getState().open(activeId);
  }, [showsCanvas, activeId]);

  const cols = `${leftOpen ? 'var(--left-w)' : '0px'} 1fr ${rightOpen ? 'var(--right-w)' : '0px'}`;
  return (
    <div className="app" style={{ gridTemplateColumns: cols }}>
      <TopBar />
      <aside className={`left ${leftOpen ? '' : 'hidden'}`}>
        {module === 'library' ? (
          <LibraryLeft />
        ) : (
          <>
            <Navigator />
            <PresetsPanel />
            <SnapshotsPanel />
            <HistoryPanel />
          </>
        )}
      </aside>
      <main className="center">
        {module === 'library' && <FilterBar />}
        <div className="center-body">{module === 'library' && libView === 'grid' ? <Grid /> : <DevelopCanvas readOnly={module === 'library'} />}</div>
        {module === 'library' ? <LibraryToolbar /> : <DevelopToolbar />}
      </main>
      <aside className={`right ${rightOpen ? '' : 'hidden'}`}>{module === 'library' ? <div className="panel-scroll"><MetadataPanel /></div> : (
          <>
            <DevelopRight />
            <AiDock />
          </>
        )}
      </aside>
      {filmstripOpen && (
        <footer className="bottom">
          <Filmstrip />
        </footer>
      )}
      <DialogHost />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

function LibraryToolbar() {
  const view = useLibrary((s) => s.view);
  const setView = useLibrary((s) => s.setView);
  const q = useLibrary((s) => s.query);
  const setQuery = useLibrary((s) => s.setQuery);
  const thumbSize = useLibrary((s) => s.thumbSize);
  const setThumbSize = useLibrary((s) => s.setThumbSize);
  return (
    <div className="toolbar">
      <Seg
        small
        value={view}
        options={[
          { value: 'grid', label: '▦ Grid', title: 'Grid (G)' },
          { value: 'loupe', label: '▢ Loupe', title: 'Loupe (E)' },
        ]}
        onChange={setView}
      />
      <span className="tb-label">Sort</span>
      <select value={q.sort ?? 'captured'} onChange={(e) => setQuery({ sort: e.target.value as SortKey })}>
        <option value="captured">Capture time</option>
        <option value="imported">Import time</option>
        <option value="edited">Edit time</option>
        <option value="filename">File name</option>
        <option value="rating">Rating</option>
      </select>
      <button className="icon-btn" title="Sort direction" onClick={() => setQuery({ desc: !q.desc })}>
        {q.desc ? '↓' : '↑'}
      </button>
      <span className="spacer" />
      {view === 'grid' && (
        <>
          <span className="tb-label">Thumbnails</span>
          <input type="range" min={100} max={420} value={thumbSize} onChange={(e) => setThumbSize(Number(e.target.value))} />
        </>
      )}
    </div>
  );
}

function DevelopToolbar() {
  const openDialog = useDialogs((s) => s.open);
  const clipboard = useDevelop((s) => s.clipboard);
  const view = useDevelop((s) => s.view);
  const source = useDevelop((s) => s.source);
  const histPos = useDevelop((s) => s.historyPos);
  const histLen = useDevelop((s) => s.history.length);
  const st = useDevelop.getState;
  const lib = useLibrary.getState;
  return (
    <div className="toolbar">
      <button disabled={!source} onClick={() => openDialog('copySettings')} title="Copy settings (⇧⌘C)">
        Copy…
      </button>
      <button disabled={!clipboard} onClick={() => void pasteToSelection()} title="Paste settings (⇧⌘V)">
        Paste
      </button>
      <button disabled={!source} onClick={() => openDialog('savePreset')} title="Save the current settings as a filter">
        Save as filter…
      </button>
      <button disabled={!source || histPos <= 0} onClick={() => st().undo()} title="Undo (⌘Z)">
        ↶
      </button>
      <button disabled={!source || histPos >= histLen - 1} onClick={() => st().redo()} title="Redo (⇧⌘Z)">
        ↷
      </button>
      <span className="spacer" />
      <Seg
        small
        value={view.mode === 'fit' ? 'fit' : String(view.zoom)}
        options={[
          { value: 'fit', label: 'Fit' },
          { value: '0.5', label: '50%' },
          { value: '1', label: '100%' },
          { value: '2', label: '200%' },
        ]}
        onChange={(v) => (v === 'fit' ? st().setView({ mode: 'fit' }) : st().setView({ mode: 'zoom', zoom: Number(v) }))}
      />
      <button className={view.before ? 'active' : ''} onClick={() => st().setView({ before: !view.before })} title="Before / after (\)">
        Before / After
      </button>
      <span className="spacer" />
      <button onClick={() => lib().moveActive(-1)} title="Previous photo (←)">
        ‹
      </button>
      <button onClick={() => lib().moveActive(1)} title="Next photo (→)">
        ›
      </button>
      <button disabled={!source} onClick={() => st().resetAll()} title="Reset all settings (⇧⌘R)">
        Reset
      </button>
    </div>
  );
}
