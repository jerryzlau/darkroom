import { useMemo, useState } from 'react';
import { backend } from '../../ipc/backend';
import { startImport, startImportFiles } from '../../lib/shortcuts';
import type { Folder } from '../../ipc/types';
import { useLibrary } from '../../state/library';
import { toast } from '../../state/toast';
import { confirmDialog, useDialogs } from '../dialogs/dialogState';
import { Section, useContextMenu } from '../ui';

export function LibraryLeft() {
  return (
    <>
      <CatalogSection />
      <FoldersSection />
      <CollectionsSection />
      <KeywordsSection />
    </>
  );
}

function CatalogSection() {
  const q = useLibrary((s) => s.query);
  const setQuery = useLibrary((s) => s.setQuery);
  const folders = useLibrary((s) => s.folders);
  const total = folders.filter((f) => f.parentId === null).reduce((a, f) => a + subtreeCount(folders, f.id), 0);
  const item = (label: string, active: boolean, onClick: () => void, count?: number) => (
    <div className={`tree-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="tree-label">{label}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </div>
  );
  return (
    <Section id="catalog" title="Catalog">
      {item('All Photographs', q.source === 'all' && q.edited == null, () => setQuery({ source: 'all', sourceId: null, edited: null }), total)}
      {item('Previous Import', q.source === 'lastImport', () => setQuery({ source: 'lastImport', sourceId: null, edited: null }))}
      {item('Edited', q.source === 'all' && q.edited === true, () => setQuery({ source: 'all', sourceId: null, edited: true }))}
    </Section>
  );
}

function subtreeCount(folders: Folder[], id: number): number {
  return folders.filter((f) => f.id === id).reduce((a, f) => a + f.count, 0) + folders.filter((f) => f.parentId === id).reduce((a, f) => a + subtreeCount(folders, f.id), 0);
}

function FoldersSection() {
  const folders = useLibrary((s) => s.folders);
  const q = useLibrary((s) => s.query);
  const setQuery = useLibrary((s) => s.setQuery);
  const refresh = useLibrary((s) => s.refresh);
  const menu = useContextMenu();
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const roots = useMemo(() => folders.filter((f) => f.parentId === null || !folders.some((p) => p.id === f.parentId)), [folders]);


  const node = (f: Folder, depth: number): React.ReactNode => {
    const children = folders.filter((c) => c.parentId === f.id);
    const open = !collapsed.has(f.id);
    const active = q.source === 'folder' && q.sourceId === f.id;
    return (
      <div key={f.id}>
        <div
          className={`tree-item ${active ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setQuery({ source: 'folder', sourceId: f.id, edited: null })}
          title={f.path}
          onContextMenu={(e) =>
            menu.open(e, [
              { label: 'Synchronize folder', onClick: () => backend().rescanFolder(f.id).then(() => toast(`Scanning ${f.name}…`)) },
              { label: 'Show in Finder', onClick: () => backend().revealInFinder(f.path) },
              { separator: true, label: '' },
              {
                label: 'Remove from catalog…',
                danger: true,
                onClick: () =>
                  confirmDialog({
                    title: 'Remove folder',
                    message: `Remove “${f.name}” and its photos from the catalog? Files on disk are not touched, but edits stored only in the catalog will be lost.`,
                    confirmLabel: 'Remove',
                    danger: true,
                    onConfirm: async () => {
                      await backend().removeFolder(f.id);
                      await refresh();
                    },
                  }),
              },
            ])
          }
        >
          {children.length > 0 ? (
            <span
              className="twisty"
              onClick={(e) => {
                e.stopPropagation();
                const s = new Set(collapsed);
                if (open) s.add(f.id);
                else s.delete(f.id);
                setCollapsed(s);
              }}
            >
              {open ? '▾' : '▸'}
            </span>
          ) : (
            <span className="twisty" />
          )}
          <span className="tree-label">{depth === 0 ? f.path.replace(/^\/Users\/[^/]+/, '~') : f.name}</span>
          <span className="count">{subtreeCount(folders, f.id)}</span>
        </div>
        {open && children.map((c) => node(c, depth + 1))}
      </div>
    );
  };

  return (
    <Section
      id="folders"
      title="Folders"
      right={
        <button
          className="icon-btn small"
          title="Import…"
          onClick={(e) => {
            e.stopPropagation();
            menu.open(e, [
              { label: 'Import folder…', shortcut: '⇧⌘I', onClick: () => void startImport() },
              { label: 'Import files…', shortcut: '⌥⇧⌘I', onClick: () => void startImportFiles() },
            ]);
          }}
        >
          ＋
        </button>
      }
    >
      {folders.length === 0 && (
        <div className="empty-hint">
          <p>No folders yet.</p>
          <button className="primary" onClick={() => void startImport()}>
            Import a folder…
          </button>
          <button onClick={() => void startImportFiles()}>Import files…</button>
        </div>
      )}
      {roots.map((f) => node(f, 0))}
      {menu.node}
    </Section>
  );
}

function CollectionsSection() {
  const collections = useLibrary((s) => s.collections);
  const q = useLibrary((s) => s.query);
  const setQuery = useLibrary((s) => s.setQuery);
  const refreshSidebar = useLibrary((s) => s.refreshSidebar);
  const openDialog = useDialogs((s) => s.open);
  const menu = useContextMenu();
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  return (
    <Section
      id="collections"
      title="Collections"
      right={
        <button
          className="icon-btn small"
          title="New collection"
          onClick={(e) => {
            e.stopPropagation();
            menu.open(e, [
              { label: 'New collection…', onClick: () => openDialog('collection', { kind: 'manual' }) },
              { label: 'New smart collection…', onClick: () => openDialog('collection', { kind: 'smart' }) },
            ]);
          }}
        >
          ＋
        </button>
      }
    >
      {collections.length === 0 && <div className="hint">Drag photos onto a collection to add them.</div>}
      {collections.map((c) => (
        <div
          key={c.id}
          className={`tree-item ${q.source === 'collection' && q.sourceId === c.id ? 'active' : ''} ${dropTarget === c.id ? 'drop' : ''}`}
          onClick={() => setQuery({ source: 'collection', sourceId: c.id, edited: null })}
          onDragOver={(e) => {
            if (c.kind !== 'manual') return;
            e.preventDefault();
            setDropTarget(c.id);
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={async (e) => {
            setDropTarget(null);
            const ids = JSON.parse(e.dataTransfer.getData('application/x-darkroom-images') || '[]') as number[];
            if (!ids.length) return;
            await backend().addToCollection(c.id, ids);
            toast(`Added ${ids.length} photo${ids.length === 1 ? '' : 's'} to “${c.name}”`);
            void refreshSidebar();
          }}
          onContextMenu={(e) =>
            menu.open(e, [
              {
                label: 'Add selected photos',
                disabled: c.kind !== 'manual',
                onClick: async () => {
                  await backend().addToCollection(c.id, useLibrary.getState().targetIds());
                  void refreshSidebar();
                },
              },
              {
                label: 'Remove selected photos',
                disabled: c.kind !== 'manual',
                onClick: async () => {
                  await backend().removeFromCollection(c.id, useLibrary.getState().targetIds());
                  void useLibrary.getState().refresh();
                },
              },
              { label: 'Edit…', onClick: () => openDialog('collection', { kind: c.kind, collection: c }) },
              { separator: true, label: '' },
              {
                label: 'Delete collection',
                danger: true,
                onClick: () =>
                  confirmDialog({
                    title: 'Delete collection',
                    message: `Delete “${c.name}”? The photos stay in the catalog.`,
                    confirmLabel: 'Delete',
                    danger: true,
                    onConfirm: async () => {
                      await backend().deleteCollection(c.id);
                      if (q.source === 'collection' && q.sourceId === c.id) setQuery({ source: 'all', sourceId: null });
                      void refreshSidebar();
                    },
                  }),
              },
            ])
          }
        >
          <span className="twisty">{c.kind === 'smart' ? '⚙' : '▣'}</span>
          <span className="tree-label">{c.name}</span>
          <span className="count">{c.count}</span>
        </div>
      ))}
      {menu.node}
    </Section>
  );
}

function KeywordsSection() {
  const keywords = useLibrary((s) => s.keywords);
  const q = useLibrary((s) => s.query);
  const setQuery = useLibrary((s) => s.setQuery);
  if (!keywords.length) return null;
  return (
    <Section id="keywordlist" title="Keywords" defaultOpen={false}>
      {keywords.map(([k, n]) => (
        <div key={k} className={`tree-item ${q.keyword === k ? 'active' : ''}`} onClick={() => setQuery({ keyword: q.keyword === k ? '' : k })}>
          <span className="tree-label">{k}</span>
          <span className="count">{n}</span>
        </div>
      ))}
    </Section>
  );
}
