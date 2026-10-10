import { startImport, startImportFiles } from '../lib/shortcuts';
import { useLibrary } from '../state/library';
import { useUi, type Module } from '../state/ui';
import { useDialogs } from './dialogs/dialogState';
import { useContextMenu } from './ui';

export function TopBar() {
  const module = useUi((s) => s.module);
  const setModule = useUi((s) => s.setModule);
  const progress = useLibrary((s) => s.importProgress);
  const openDialog = useDialogs((s) => s.open);
  const menu = useContextMenu();
  const tab = (m: Module, label: string, key: string) => (
    <button className={`module-tab ${module === m ? 'active' : ''}`} onClick={() => setModule(m)} title={`${label} (${key})`}>
      {label}
    </button>
  );
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <span className="logo">◐</span> Darkroom
      </div>
      <div className="import-area" data-tauri-drag-region>
        <button
          onClick={(e) =>
            menu.open(e, [
              { label: 'Import folder…', shortcut: '⇧⌘I', onClick: () => void startImport() },
              { label: 'Import files…', shortcut: '⌥⇧⌘I', onClick: () => void startImportFiles() },
            ])
          }
        >
          ⤓ Import
        </button>
        <button onClick={() => openDialog('export', { ids: useLibrary.getState().targetIds() })} title="Export selected photos (⇧⌘E)">
          ⤒ Export
        </button>
        {progress && (
          <div className="import-progress" title={progress.message}>
            <span>
              {progress.phase === 'scanning' ? 'Scanning…' : progress.phase === 'metadata' ? 'Reading metadata' : 'Building previews'}
              {progress.total > 0 ? ` ${progress.done}/${progress.total}` : ''}
            </span>
            <div className="bar">
              <div style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '15%' }} className={progress.total ? '' : 'indeterminate'} />
            </div>
          </div>
        )}
      </div>
      <nav className="modules" data-tauri-drag-region>
        {tab('library', 'Library', 'G')}
        <span className="sep">|</span>
        {tab('develop', 'Develop', 'D')}
      </nav>
      <div className="top-actions">
        <button className="icon-btn" title="Filter library…" onClick={() => openDialog('filterLibrary', { ids: useLibrary.getState().targetIds() })}>
          ◧ Filters
        </button>
        <button className="icon-btn" title="Keyboard shortcuts (?)" onClick={() => openDialog('shortcuts')}>
          ?
        </button>
        <button className="icon-btn" title="Settings" onClick={() => openDialog('settings')}>
          ⚙
        </button>
      </div>
      {menu.node}
    </header>
  );
}
