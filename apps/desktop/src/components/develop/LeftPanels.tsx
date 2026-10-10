import { applyPartial, BUILTIN_PRESETS, normalizeParams, type EditParams, type PartialParams } from '@darkroom/core';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { backend } from '../../ipc/backend';
import type { Preset } from '../../ipc/types';
import { applyPresetToSelection, deletePresetConfirmed, parsePresetParams, toggleFavorite } from '../../lib/presetActions';
import { cancelPreviewRenders, renderParamsThumb } from '../../lib/renderPreview';
import { useDevelop } from '../../state/develop';
import { useLibrary } from '../../state/library';
import { Section, useContextMenu } from '../ui';
import { useDialogs } from '../dialogs/dialogState';

export function Navigator() {
  const image = useDevelop((s) => s.image);
  const view = useDevelop((s) => s.view);
  const row = useLibrary((s) => s.images.find((i) => i.id === image?.id));
  const setView = useDevelop((s) => s.setView);
  if (!image) return <Section id="nav" title="Navigator"><div className="hint">No photo</div></Section>;
  const url = backend().thumbUrl(image.id, row?.thumbRev ?? image.thumbRev);
  return (
    <Section
      id="nav"
      title="Navigator"
      right={
        <span className="nav-zoom">
          <button className={`link-btn ${view.mode === 'fit' ? 'active' : ''}`} onClick={() => setView({ mode: 'fit' })}>
            Fit
          </button>
          {[0.5, 1, 2].map((z) => (
            <button key={z} className={`link-btn ${view.mode === 'zoom' && Math.abs(view.zoom - z) < 0.01 ? 'active' : ''}`} onClick={() => setView({ mode: 'zoom', zoom: z })}>
              {z * 100}%
            </button>
          ))}
        </span>
      }
    >
      <div
        className="navigator"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).querySelector('img')!.getBoundingClientRect();
          const u = (e.clientX - r.left) / r.width;
          const v = (e.clientY - r.top) / r.height;
          setView({ center: [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))], mode: view.mode === 'fit' ? 'zoom' : view.mode, zoom: view.mode === 'fit' ? 1 : view.zoom });
        }}
      >
        <img src={url} alt="" draggable={false} />
      </div>
    </Section>
  );
}

interface PresetCardItem {
  /** cache / React key: `u${id}:${updatedAt}` for user presets, the builtin id otherwise */
  key: string;
  name: string;
  params: PartialParams;
  description?: string;
  user?: Preset;
}

/** Rendered preset thumbnails (data URLs) for the params in `thumbsFor`; cleared when those change. */
const thumbCache = new Map<string, string>();
let thumbsFor: EditParams | null = null;

function PresetCard({ item, thumbBase, onMenu }: { item: PresetCardItem; thumbBase: EditParams | null; onMenu: (e: MouseEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(item.key) ?? null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { rootMargin: '120px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const { key, params } = item;
  useEffect(() => {
    if (!thumbBase || !visible) return;
    const hit = thumbCache.get(key);
    if (hit) {
      setUrl(hit);
      return;
    }
    let alive = true;
    void renderParamsThumb(applyPartial(thumbBase, params, useDevelop.getState().base), 160, 0.8, { scope: 'presets' }).then((u) => {
      if (!u) return;
      if (thumbsFor === thumbBase) thumbCache.set(key, u);
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
    // params is derived from key (builtin id / user id+updatedAt)
  }, [thumbBase, visible, key]);
  const fav = item.user?.favorite ?? false;
  return (
    <div
      ref={ref}
      className="preset-card"
      title={item.description || item.name}
      onClick={() => useDevelop.getState().applyPreset(item.params, item.name)}
      onContextMenu={onMenu}
    >
      {thumbBase && <div className={`preset-thumb ${url ? '' : 'loading'}`}>{url && <img src={url} alt="" draggable={false} />}</div>}
      <div className="preset-card-row">
        <span className="preset-card-name">{item.name}</span>
        {item.user?.source === 'ai' && <span className="preset-badge">AI</span>}
        {item.user && (
          <button
            className={`preset-star ${fav ? 'on' : ''}`}
            title={fav ? 'Remove from favorites' : 'Add to favorites'}
            onClick={(e) => {
              e.stopPropagation();
              void toggleFavorite(item.user!);
            }}
          >
            {fav ? '★' : '☆'}
          </button>
        )}
      </div>
    </div>
  );
}

export function PresetsPanel() {
  const presets = useDevelop((s) => s.presets);
  const loadPresets = useDevelop((s) => s.loadPresets);
  const applyPreset = useDevelop((s) => s.applyPreset);
  const committed = useDevelop((s) => s.committed);
  const source = useDevelop((s) => s.source);
  const imageId = useDevelop((s) => s.imageId);
  const openDialog = useDialogs((s) => s.open);
  const menu = useContextMenu();
  const [filter, setFilter] = useState('');
  // params the thumbnails are rendered against (debounced: history jumps / commits can be frequent)
  const [thumbBase, setThumbBase] = useState<EditParams | null>(() => (committed === thumbsFor ? committed : null));
  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);
  useEffect(() => {
    if (!source) return;
    if (committed === thumbsFor) {
      setThumbBase(committed);
      return;
    }
    const t = setTimeout(() => {
      thumbCache.clear();
      cancelPreviewRenders('presets');
      thumbsFor = committed;
      setThumbBase(committed);
    }, 400);
    return () => clearTimeout(t);
  }, [committed, source, imageId]);

  const groups = useMemo(() => {
    const g = new Map<string, PresetCardItem[]>();
    g.set('Favorites', []); // first; user favorites are listed only here
    const add = (group: string, item: PresetCardItem) => {
      if (filter && !`${group} ${item.name} ${item.description ?? ''}`.toLowerCase().includes(filter.toLowerCase())) return;
      if (!g.has(group)) g.set(group, []);
      g.get(group)!.push(item);
    };
    for (const p of presets) {
      const params = parsePresetParams(p);
      if (!params) continue; // skip corrupt preset
      add(p.favorite ? 'Favorites' : p.group || 'User Presets', { key: `u${p.id}:${p.updatedAt}`, name: p.name, params, description: p.description, user: p });
    }
    for (const p of BUILTIN_PRESETS) add(p.group, { key: p.id, name: p.name, params: p.params });
    return [...g.entries()].filter(([, items]) => items.length);
  }, [presets, filter]);

  const itemMenu = (it: PresetCardItem) => (e: MouseEvent) => {
    const u = it.user;
    menu.open(e, [
      { label: 'Apply', onClick: () => applyPreset(it.params, it.name) },
      { label: 'Apply to selected photos', onClick: () => void applyPresetToSelection(it.name, it.params) },
      ...(u ? [{ label: u.favorite ? 'Unfavorite' : 'Favorite', onClick: () => void toggleFavorite(u) }] : []),
      ...(u ? [{ label: 'Edit…', onClick: () => openDialog('filterLibrary', { editId: u.id }) }] : []),
      ...(u
        ? [
            { separator: true, label: '' },
            { label: 'Delete…', danger: true, onClick: () => deletePresetConfirmed(u) },
          ]
        : []),
    ]);
  };

  return (
    <Section
      id="presets"
      title="Presets"
      right={
        <>
          <button className="icon-btn small" title="Filter library…" onClick={(e) => { e.stopPropagation(); openDialog('filterLibrary', { ids: useLibrary.getState().targetIds() }); }}>
            ☰
          </button>
          <button className="icon-btn small" title="Create preset" onClick={(e) => { e.stopPropagation(); openDialog('savePreset'); }}>
            ＋
          </button>
        </>
      }
    >
      <input className="search" placeholder="Filter presets" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {groups.map(([group, items]) => (
        <div key={group} className="preset-group">
          <div className="preset-group-title">{group}</div>
          <div className="preset-cards">
            {items.map((it) => (
              <PresetCard key={it.key} item={it} thumbBase={source ? thumbBase : null} onMenu={itemMenu(it)} />
            ))}
          </div>
        </div>
      ))}
      {menu.node}
    </Section>
  );
}

export function SnapshotsPanel() {
  const snapshots = useDevelop((s) => s.snapshots);
  const imageId = useDevelop((s) => s.imageId);
  const st = useDevelop.getState;
  const menu = useContextMenu();
  const create = async () => {
    if (imageId == null) return;
    const name = `Snapshot ${new Date().toLocaleString()}`;
    await backend().createSnapshot(imageId, name, JSON.stringify(st().params));
    await st().loadSnapshots();
  };
  return (
    <Section id="snapshots" title="Snapshots" defaultOpen={false} right={<button className="icon-btn small" title="Create snapshot" onClick={(e) => { e.stopPropagation(); void create(); }}>＋</button>}>
      {snapshots.length === 0 && <div className="hint">Snapshots save the current settings so you can return to them.</div>}
      {snapshots.map((s) => (
        <div
          key={s.id}
          className="preset-item"
          onClick={() => {
            st().replace(normalizeParams(JSON.parse(s.params), st().base));
            st().commit(`Snapshot: ${s.name}`);
          }}
          onContextMenu={(e) =>
            menu.open(e, [
              {
                label: 'Delete snapshot',
                danger: true,
                onClick: async () => {
                  await backend().deleteSnapshot(s.id);
                  await st().loadSnapshots();
                },
              },
            ])
          }
        >
          {s.name}
        </div>
      ))}
      {menu.node}
    </Section>
  );
}

export function HistoryPanel() {
  const history = useDevelop((s) => s.history);
  const pos = useDevelop((s) => s.historyPos);
  const goHistory = useDevelop((s) => s.goHistory);
  const imageId = useDevelop((s) => s.imageId);
  return (
    <Section
      id="history"
      title="History"
      right={
        <button
          className="icon-btn small"
          title="Clear history"
          onClick={async (e) => {
            e.stopPropagation();
            if (imageId == null) return;
            await backend().clearHistory(imageId);
            const s = useDevelop.getState();
            const entry = await backend().saveParams(imageId, JSON.stringify(s.params), s.image?.edited ?? false, 'History cleared', null);
            useDevelop.setState({ history: entry ? [entry] : [], historyPos: 0 });
          }}
        >
          ⌫
        </button>
      }
    >
      <div className="history-list">
        {[...history].map((h, i) => ({ h, i })).reverse().map(({ h, i }) => (
          <div key={`${h.id}-${i}`} className={`history-item ${i === pos ? 'current' : ''} ${i > pos ? 'future' : ''}`} onClick={() => goHistory(i)}>
            {h.label}
          </div>
        ))}
      </div>
    </Section>
  );
}
