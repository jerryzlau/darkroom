import { applyPartial, BUILTIN_PRESETS, SECTION_LABELS, type PartialParams } from '@darkroom/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { backend } from '../../ipc/backend';
import type { Preset } from '../../ipc/types';
import { applyPresetToSelection, deletePresetConfirmed, parsePresetParams, presetSections } from '../../lib/presetActions';
import { renderParamsThumb } from '../../lib/renderPreview';
import { useDevelop } from '../../state/develop';
import { useLibrary } from '../../state/library';
import { toast } from '../../state/toast';
import { Field, Modal } from '../ui';
import { useDialogs, type FilterLibraryProps } from './dialogState';

interface Entry {
  key: string;
  name: string;
  group: string;
  params: PartialParams;
  user?: Preset;
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export function FilterLibraryDialog(props: FilterLibraryProps & { onClose: () => void }) {
  const presets = useDevelop((s) => s.presets);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(props.editId != null ? `u${props.editId}` : null);
  useEffect(() => {
    void useDevelop.getState().loadPresets();
  }, []);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const p of presets) {
      const params = parsePresetParams(p);
      if (params) out.push({ key: `u${p.id}`, name: p.name, group: p.group || 'User Presets', params, user: p });
    }
    for (const b of BUILTIN_PRESETS) out.push({ key: b.id, name: b.name, group: b.group, params: b.params });
    return out;
  }, [presets]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (e: Entry) => !q || `${e.group} ${e.name} ${e.user?.description ?? ''}`.toLowerCase().includes(q);
    const groups = new Map<string, Entry[]>([['Favorites', []]]);
    const add = (g: string, e: Entry) => {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(e);
    };
    for (const e of entries.filter(match)) {
      if (!e.user) continue;
      if (e.user.favorite) add('Favorites', e);
      add(e.group, e);
    }
    const builtin = entries.filter((e) => !e.user && match(e));
    if (builtin.length) groups.set('Built-in', builtin);
    return [...groups.entries()].filter(([, l]) => l.length);
  }, [entries, query]);

  // keep a valid selection: requested one, else the first user preset, else the first entry
  useEffect(() => {
    if (sel && entries.some((e) => e.key === sel)) return;
    if (!presets.length && sel?.startsWith('u') && props.editId != null) return; // still loading
    const first = entries.find((e) => e.user) ?? entries[0];
    setSel(first?.key ?? null);
  }, [entries, sel, presets.length, props.editId]);

  const current = entries.find((e) => e.key === sel) ?? null;
  const reopen = () => useDialogs.getState().open('filterLibrary', { ids: props.ids, editId: undefined });

  return (
    <Modal title="Filter Library" onClose={props.onClose} width={820} footer={<button onClick={props.onClose}>Close</button>}>
      <div className="filter-lib">
        <div className="filter-lib-list">
          <input className="search" placeholder="Search filters" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={stop} autoFocus={props.editId == null} />
          <div className="filter-lib-rows">
            {sections.map(([group, list]) => (
              <div key={group} className="filter-lib-group">
                <div className="preset-group-title">{group}</div>
                {list.map((e) => (
                  <div key={`${group}:${e.key}`} className={`filter-lib-row ${e.key === sel ? 'selected' : ''}`} onClick={() => setSel(e.key)} title={e.user?.description || e.name}>
                    <span className="filter-lib-name">{e.name}</span>
                    {e.user?.source === 'ai' && <span className="preset-badge">AI</span>}
                    {e.user?.favorite && <span className="preset-star on">★</span>}
                  </div>
                ))}
              </div>
            ))}
            {!sections.length && <div className="hint">No filters match.</div>}
          </div>
        </div>
        <div className="filter-lib-editor">
          {current ? (
            <Editor
              key={current.key}
              entry={current}
              ids={props.ids}
              groups={[...new Set(presets.map((p) => p.group || 'User Presets'))]}
              onDelete={(p) => deletePresetConfirmed(p, reopen)}
            />
          ) : (
            <div className="hint">No filters yet. Save one from Develop with “Save as filter…”.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Editor({ entry, ids, groups, onDelete }: { entry: Entry; ids?: number[]; groups: string[]; onDelete: (p: Preset) => void }) {
  const user = entry.user;
  const [name, setName] = useState(entry.name);
  const [group, setGroup] = useState(entry.group);
  const [description, setDescription] = useState(user?.description ?? '');
  const committed = useDevelop((s) => s.committed);
  const source = useDevelop((s) => s.source);
  const imageId = useDevelop((s) => s.imageId);
  const selected = useLibrary((s) => s.selected);
  const activeId = useLibrary((s) => s.activeId);
  const targets = useMemo(() => ids ?? useLibrary.getState().targetIds(), [ids, selected, activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [thumb, setThumb] = useState<string | null>(null);
  const affects = presetSections(entry.params).map((s) => SECTION_LABELS[s]);

  // save pending edits (blur, Enter, unmount); `saved` = last persisted values
  const draft = useRef({ name, group, description });
  draft.current = { name, group, description };
  const saved = useRef({ name: entry.name, group: entry.group, description: user?.description ?? '' });
  const save = useRef(async () => {});
  save.current = async () => {
    if (!user) return;
    const d = draft.current;
    const patch: { name?: string; group?: string; description?: string } = {};
    const n = d.name.trim();
    const g = d.group.trim() || 'User Presets';
    const desc = d.description.trim();
    if (!n) {
      setName(saved.current.name);
      toast('Filter name cannot be empty', 'warn');
    } else if (n !== saved.current.name) patch.name = n;
    if (g !== saved.current.group) patch.group = g;
    if (desc !== saved.current.description) patch.description = desc;
    if (!Object.keys(patch).length) return;
    saved.current = { ...saved.current, ...patch };
    await backend().updatePreset(user.id, patch);
    await useDevelop.getState().loadPresets();
  };
  useEffect(() => () => void save.current(), []);

  useEffect(() => {
    if (!source) {
      setThumb(null);
      return;
    }
    let alive = true;
    void renderParamsThumb(applyPartial(committed, entry.params, useDevelop.getState().base), 320, 0.8, { scope: 'filterLibrary' }).then((u) => alive && setThumb(u));
    return () => {
      alive = false;
    };
  }, [committed, source, entry.params]);

  const n = targets.length;
  const applyLabel = source && n === 1 && targets[0] === imageId ? 'Apply' : `Apply to ${n} selected`;
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') e.currentTarget.blur();
  };

  return (
    <>
      {source && <div className={`preset-thumb large ${thumb ? '' : 'loading'}`}>{thumb && <img src={thumb} alt="" draggable={false} />}</div>}
      {user ? (
        <>
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void save.current()} onKeyDown={onEnter} />
          </Field>
          <Field label="Group">
            <input list="filter-lib-groups" value={group} onChange={(e) => setGroup(e.target.value)} onBlur={() => void save.current()} onKeyDown={onEnter} />
            <datalist id="filter-lib-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <Field label="Description">
            <textarea className="preset-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => void save.current()} onKeyDown={stop} />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={user.favorite}
              onChange={async (e) => {
                await backend().updatePreset(user.id, { favorite: e.target.checked });
                await useDevelop.getState().loadPresets();
              }}
            />
            Favorite
          </label>
        </>
      ) : (
        <>
          <div className="filter-lib-title">{entry.name}</div>
          <div className="field-hint">Built-in · {entry.group}</div>
        </>
      )}
      <div className="filter-lib-affects">
        <span className="field-label">Affects: </span>
        {affects.length ? affects.join(', ') : 'nothing'}
      </div>
      <div className="filter-lib-actions">
        <button className="primary" disabled={!n} onClick={() => void applyPresetToSelection(user ? user.name : entry.name, entry.params, targets)}>
          {applyLabel}
        </button>
        {user && (
          <button className="danger" onClick={() => onDelete(user)}>
            Delete
          </button>
        )}
      </div>
    </>
  );
}
