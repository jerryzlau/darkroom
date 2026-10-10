import { pickSections, SECTION_LABELS, SECTIONS, type SectionName } from '@darkroom/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultExportSettings, exportImages, fileName, type ExportProgress, type ExportSettings } from '../../lib/background';
import { backend } from '../../ipc/backend';
import { DEFAULT_MODEL, SETTING_KEY, SETTING_MODEL } from '../../lib/ai';
import { useAiChat } from '../../state/aiChat';
import type { AppInfo, Collection, SmartRules } from '../../ipc/types';
import { useDevelop } from '../../state/develop';
import { useLibrary } from '../../state/library';
import { toast } from '../../state/toast';
import { Field, Modal, Seg } from '../ui';
import { FilterLibraryDialog } from './FilterLibraryDialog';
import { useDialogs, type ConfirmProps, type FilterLibraryProps, type SavePresetProps } from './dialogState';

export function DialogHost() {
  const name = useDialogs((s) => s.name);
  const props = useDialogs((s) => s.props);
  const close = useDialogs((s) => s.close);
  switch (name) {
    case 'export':
      return <ExportDialog ids={(props.ids as number[]) ?? useLibrary.getState().targetIds()} onClose={close} />;
    case 'copySettings':
      return <CopySettingsDialog onClose={close} />;
    case 'savePreset':
      return <SavePresetDialog {...(props as SavePresetProps)} onClose={close} />;
    case 'collection':
      return <CollectionDialog kind={(props.kind as 'manual' | 'smart') ?? 'manual'} collection={props.collection as Collection | undefined} onClose={close} />;
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />;
    case 'settings':
      return <SettingsDialog onClose={close} />;
    case 'confirm':
      return <ConfirmDialog {...(props as unknown as ConfirmProps)} onClose={close} />;
    case 'filterLibrary':
      return <FilterLibraryDialog {...(props as FilterLibraryProps)} onClose={close} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------

const ALL_SECTIONS = Object.keys(SECTIONS) as SectionName[];
const DEFAULT_COPY: SectionName[] = ALL_SECTIONS.filter((s) => s !== 'crop' && s !== 'masks');

export function SectionPicker({ value, onChange }: { value: SectionName[]; onChange: (v: SectionName[]) => void }) {
  return (
    <div className="section-picker">
      <div className="btn-row">
        <button onClick={() => onChange(ALL_SECTIONS)}>Check all</button>
        <button onClick={() => onChange([])}>Check none</button>
      </div>
      <div className="checks">
        {ALL_SECTIONS.map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={value.includes(s)} onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((x) => x !== s))} />
            {SECTION_LABELS[s]}
          </label>
        ))}
      </div>
    </div>
  );
}

function CopySettingsDialog({ onClose }: { onClose: () => void }) {
  const [sections, setSections] = useState<SectionName[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('darkroom.copySections') ?? 'null') ?? DEFAULT_COPY;
    } catch {
      return DEFAULT_COPY;
    }
  });
  return (
    <Modal
      title="Copy Settings"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!sections.length}
            onClick={() => {
              localStorage.setItem('darkroom.copySections', JSON.stringify(sections));
              useDevelop.getState().copy(sections);
              onClose();
            }}
          >
            Copy
          </button>
        </>
      }
    >
      <SectionPicker value={sections} onChange={setSections} />
    </Modal>
  );
}

function SavePresetDialog(props: SavePresetProps & { onClose: () => void }) {
  const { onClose, fromParams, source } = props;
  const [name, setName] = useState(props.name ?? '');
  const [group, setGroup] = useState(props.group ?? 'User Presets');
  const [description, setDescription] = useState(props.description ?? '');
  const [sections, setSections] = useState<SectionName[]>(props.sections ?? DEFAULT_COPY.filter((s) => s !== 'whiteBalance'));
  const [includeExposure, setIncludeExposure] = useState(!(props.excludeExposure ?? false));
  const isFilter = source === 'ai';
  const save = async () => {
    const params = pickSections(fromParams ?? useDevelop.getState().params, sections);
    if (!includeExposure) delete params.exposure;
    await backend().savePreset(group.trim() || 'User Presets', name.trim(), JSON.stringify(params), description.trim(), source ?? 'user');
    await useDevelop.getState().loadPresets();
    toast(`Saved ${isFilter ? 'filter' : 'preset'} “${name.trim()}”`);
    onClose();
  };
  return (
    <Modal
      title={isFilter ? 'New Filter' : 'New Develop Preset'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim() || !sections.length} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      <Field label="Group">
        <input value={group} onChange={(e) => setGroup(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      <Field label="Description">
        <textarea className="preset-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      <div className="field-label">Include</div>
      <SectionPicker value={sections} onChange={setSections} />
      {sections.includes('basicTone') && (
        <label className="check">
          <input type="checkbox" checked={includeExposure} onChange={(e) => setIncludeExposure(e.target.checked)} />
          Include exposure
        </label>
      )}
    </Modal>
  );
}

function CollectionDialog({ kind, collection, onClose }: { kind: 'manual' | 'smart'; collection?: Collection; onClose: () => void }) {
  const [name, setName] = useState(collection?.name ?? '');
  const [rules, setRules] = useState<SmartRules>(() => {
    try {
      return collection?.rules ? JSON.parse(collection.rules) : { minRating: 3, ratingOp: '>=' };
    } catch {
      return {};
    }
  });
  const [addSelected, setAddSelected] = useState(kind === 'manual' && !collection);
  const save = async () => {
    const b = backend();
    const r = kind === 'smart' ? JSON.stringify(rules) : null;
    if (collection) await b.updateCollection(collection.id, name.trim(), r);
    else {
      const id = await b.createCollection(name.trim(), kind, r);
      if (addSelected) await b.addToCollection(id, useLibrary.getState().targetIds());
    }
    await useLibrary.getState().refreshSidebar();
    onClose();
  };
  const set = (patch: Partial<SmartRules>) => setRules({ ...rules, ...patch });
  return (
    <Modal
      title={collection ? 'Edit Collection' : kind === 'smart' ? 'New Smart Collection' : 'New Collection'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim()} onClick={save}>
            {collection ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      {kind === 'manual' && !collection && (
        <label className="check">
          <input type="checkbox" checked={addSelected} onChange={(e) => setAddSelected(e.target.checked)} /> Add the selected photos
        </label>
      )}
      {kind === 'smart' && (
        <div className="rules">
          <Field label="Rating">
            <span className="row">
              <select value={rules.ratingOp ?? '>='} onChange={(e) => set({ ratingOp: e.target.value as '>=' })}>
                <option value=">=">at least</option>
                <option value="=">exactly</option>
                <option value="<=">at most</option>
              </select>
              <select value={rules.minRating ?? 0} onChange={(e) => set({ minRating: Number(e.target.value) })}>
                {[0, 1, 2, 3, 4, 5].map((r) => (
                  <option key={r} value={r}>
                    {r ? '★'.repeat(r) : 'any'}
                  </option>
                ))}
              </select>
            </span>
          </Field>
          <Field label="Flag">
            <select value={rules.flag ?? 'all'} onChange={(e) => set({ flag: e.target.value as SmartRules['flag'] })}>
              <option value="all">Any</option>
              <option value="picked">Picked</option>
              <option value="unflagged">Unflagged</option>
              <option value="notRejected">Not rejected</option>
              <option value="rejected">Rejected</option>
            </select>
          </Field>
          <Field label="Color label">
            <select value={rules.colorLabel ?? ''} onChange={(e) => set({ colorLabel: e.target.value })}>
              <option value="">Any</option>
              <option value="none">None</option>
              {['red', 'yellow', 'green', 'blue', 'purple'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Edited">
            <select value={rules.edited == null ? '' : String(rules.edited)} onChange={(e) => set({ edited: e.target.value === '' ? null : e.target.value === 'true' })}>
              <option value="">Any</option>
              <option value="true">Edited</option>
              <option value="false">Not edited</option>
            </select>
          </Field>
          <Field label="File type">
            <select value={rules.format ?? ''} onChange={(e) => set({ format: e.target.value })}>
              <option value="">Any</option>
              <option value="raw">Raw</option>
              <option value="jpeg">JPEG</option>
              <option value="heic">HEIC</option>
              <option value="png">PNG</option>
              <option value="tiff">TIFF</option>
            </select>
          </Field>
          <Field label="Keyword">
            <input value={rules.keyword ?? ''} onChange={(e) => set({ keyword: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
          </Field>
          <Field label="Camera contains">
            <input value={rules.camera ?? ''} onChange={(e) => set({ camera: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
          </Field>
          <Field label="Lens contains">
            <input value={rules.lens ?? ''} onChange={(e) => set({ lens: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
          </Field>
          <Field label="Text contains">
            <input value={rules.text ?? ''} onChange={(e) => set({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ExportDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const [s, setS] = useState<ExportSettings>(defaultExportSettings());
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [cancel, setCancel] = useState(false);
  const cancelRef = useMemo(() => ({ v: false }), []);
  const images = useLibrary((st) => st.images);

  useEffect(() => {
    backend()
      .getSetting('exportSettings')
      .then((v) => {
        if (v) setS({ ...defaultExportSettings(), ...JSON.parse(v) });
      })
      .finally(() => setLoaded(true));
  }, []);

  const set = (patch: Partial<ExportSettings>) => setS({ ...s, ...patch });
  const first = images.find((i) => i.id === ids[0]);
  const ext = s.format === 'jpeg' ? 'jpg' : s.format === 'png' ? 'png' : 'tif';

  const run = async () => {
    if (!s.folder) return toast('Choose a destination folder', 'warn');
    await backend().setSetting('exportSettings', JSON.stringify(s));
    setRunning(true);
    cancelRef.v = false;
    const res = await exportImages(ids, s, setProgress, () => cancelRef.v);
    setRunning(false);
    if (res.errors.length) toast(`${res.errors.length} export(s) failed: ${res.errors[0]}`, 'error');
    if (res.written.length) {
      toast(`Exported ${res.written.length} photo${res.written.length === 1 ? '' : 's'} to ${s.folder.replace(/^\/Users\/[^/]+/, '~')}`);
      onClose();
      if (res.written[0]) void backend().revealInFinder(res.written[0]);
    } else if (cancelRef.v) {
      onClose();
    }
  };

  if (!loaded) return null;
  return (
    <Modal
      title={`Export ${ids.length} Photo${ids.length === 1 ? '' : 's'}`}
      onClose={running ? () => undefined : onClose}
      width={520}
      footer={
        running ? (
          <>
            <div className="progress-inline">
              {progress && (
                <>
                  <div className="bar">
                    <div style={{ width: `${((progress.index + progress.fraction) / progress.total) * 100}%` }} />
                  </div>
                  <span>
                    {progress.index + 1} / {progress.total} · {progress.file}
                  </span>
                </>
              )}
            </div>
            <button
              disabled={cancel}
              onClick={() => {
                cancelRef.v = true;
                setCancel(true);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={run} disabled={!s.folder || ids.length === 0}>
              Export
            </button>
          </>
        )
      }
    >
      <fieldset disabled={running}>
        <Field label="Destination">
          <span className="row">
            <input readOnly value={s.folder.replace(/^\/Users\/[^/]+/, '~')} placeholder="Choose a folder…" />
            <button
              onClick={async () => {
                const f = await backend().pickExportFolder();
                if (f) set({ folder: f });
              }}
            >
              Choose…
            </button>
          </span>
        </Field>
        <Field label="File name" hint={first ? `e.g. ${fileName(first, s.template, 1, ext)}  ·  tokens: {name} {seq} {date} {rating}` : undefined}>
          <input value={s.template} onChange={(e) => set({ template: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </Field>
        <Field label="Format">
          <Seg
            value={s.format}
            options={[
              { value: 'jpeg', label: 'JPEG' },
              { value: 'png', label: 'PNG' },
              { value: 'tiff', label: 'TIFF' },
            ]}
            onChange={(v) => set({ format: v })}
          />
        </Field>
        {s.format === 'jpeg' ? (
          <Field label={`Quality ${s.quality}`}>
            <input type="range" min={40} max={100} value={s.quality} onChange={(e) => set({ quality: Number(e.target.value) })} />
          </Field>
        ) : (
          <Field label="Bit depth">
            <Seg
              value={s.bitDepth}
              options={[
                { value: 8, label: '8-bit' },
                { value: 16, label: '16-bit' },
              ]}
              onChange={(v) => set({ bitDepth: v })}
            />
          </Field>
        )}
        <Field label="Color space">
          <Seg
            value={s.colorSpace}
            options={[
              { value: 'srgb', label: 'sRGB' },
              { value: 'p3', label: 'Display P3' },
              { value: 'prophoto', label: 'ProPhoto RGB' },
            ]}
            onChange={(v) => set({ colorSpace: v })}
          />
        </Field>
        <label className="check">
          <input type="checkbox" checked={s.resize} onChange={(e) => set({ resize: e.target.checked })} /> Resize long edge to
          <input type="number" className="num" min={64} max={20000} value={s.longEdge} disabled={!s.resize} onChange={(e) => set({ longEdge: Number(e.target.value) || 2048 })} onKeyDown={(e) => e.stopPropagation()} /> px
        </label>
        <label className="check">
          <input type="checkbox" checked={s.includeMetadata} onChange={(e) => set({ includeMetadata: e.target.checked })} /> Include camera metadata
        </label>
        <label className="check">
          <input type="checkbox" checked={s.includeLocation} disabled={!s.includeMetadata} onChange={(e) => set({ includeLocation: e.target.checked })} /> Include location (GPS)
        </label>
        <label className="check">
          <input type="checkbox" checked={s.overwrite} onChange={(e) => set({ overwrite: e.target.checked })} /> Overwrite existing files (otherwise add a number)
        </label>
      </fieldset>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [autoXmp, setAutoXmp] = useState(false);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  useEffect(() => {
    void backend().appInfo().then(setInfo);
    void backend().getSetting('autoWriteXmp').then((v) => setAutoXmp(v === 'true'));
    void Promise.all([backend().getSetting(SETTING_KEY), backend().getSetting(SETTING_MODEL)]).then(([k, m]) => {
      savedAi.current = { [SETTING_KEY]: (k ?? '').trim(), [SETTING_MODEL]: (m ?? '').trim() };
      setAiKey(k ?? '');
      setAiModel(m ?? '');
      latestAi.current.loaded = true;
    });
  }, []);
  // last values written, so blur and close (Escape unmounts without a blur) save each change once
  const savedAi = useRef<Record<string, string>>({});
  const saveAi = async (key: string, value: string) => {
    const v = value.trim();
    if (savedAi.current[key] === v) return;
    savedAi.current[key] = v;
    try {
      await backend().setSetting(key, v);
      await useAiChat.getState().refreshKey();
    } catch (e) {
      toast(`Could not save setting: ${e}`, 'error');
    }
  };
  const latestAi = useRef({ key: aiKey, model: aiModel, loaded: false });
  latestAi.current.key = aiKey;
  latestAi.current.model = aiModel;
  useEffect(
    () => () => {
      if (!latestAi.current.loaded) return;
      void saveAi(SETTING_KEY, latestAi.current.key);
      void saveAi(SETTING_MODEL, latestAi.current.model);
    },
    [],
  );
  return (
    <Modal title="Settings" onClose={onClose} footer={<button onClick={onClose}>Done</button>}>
      <label className="check">
        <input
          type="checkbox"
          checked={autoXmp}
          onChange={async (e) => {
            setAutoXmp(e.target.checked);
            await backend().setSetting('autoWriteXmp', String(e.target.checked));
          }}
        />
        Automatically write edits to XMP sidecars next to the originals
      </label>
      <p className="hint">Sidecars are named “photo.ext.xmp” and are read back when a folder is imported again.</p>
      <h4 className="settings-h">AI Edit</h4>
      <Field
        label="Anthropic API key"
        hint="Stored unencrypted in the local catalog database. Sent only to api.anthropic.com, and only when you send a chat message. Leave empty to disable AI Edit."
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          value={aiKey}
          onChange={(e) => setAiKey(e.target.value)}
          onBlur={() => void saveAi(SETTING_KEY, aiKey)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Field>
      <Field label="Model">
        <input
          type="text"
          spellCheck={false}
          placeholder={DEFAULT_MODEL}
          value={aiModel}
          onChange={(e) => setAiModel(e.target.value)}
          onBlur={() => void saveAi(SETTING_MODEL, aiModel)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Field>
      {info && (
        <dl className="meta-list">
          <div>
            <dt>Version</dt>
            <dd>{info.version}</dd>
          </div>
          <div>
            <dt>Catalog</dt>
            <dd title={info.dataDir}>{info.dataDir}</dd>
          </div>
          <div>
            <dt>Cache</dt>
            <dd title={info.cacheDir}>{info.cacheDir}</dd>
          </div>
        </dl>
      )}
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['G', 'Grid'],
  ['E', 'Loupe'],
  ['D', 'Develop'],
  ['← →', 'Previous / next photo'],
  ['0 – 5', 'Set rating'],
  ['P / X / U', 'Pick / reject / unflag'],
  ['6 – 9', 'Red / yellow / green / blue label'],
  ['⌘A', 'Select all'],
  ['⇧⌘I', 'Import folder'],
  ['⌥⇧⌘I', 'Import files'],
  ['⇧⌘E', 'Export'],
  ["⌘'", 'Create virtual copy'],
  ['⌫', 'Remove from catalog'],
  ['⌘Z / ⇧⌘Z', 'Undo / redo'],
  ['⇧⌘C / ⇧⌘V', 'Copy / paste settings'],
  ['⇧⌘R', 'Reset all settings'],
  ['⌘N', 'New snapshot'],
  ['⌘J', 'AI Edit (chat / guided)'],
  ['\\', 'Before / after'],
  ['J', 'Show clipping'],
  ['R', 'Crop tool'],
  ['M', 'Masks'],
  ['Q', 'Spot removal'],
  ['S', 'Selection tool'],
  ['W', 'White balance selector'],
  ['O', 'Show mask overlay'],
  ['[ / ]', 'Brush size'],
  ['Z or click', 'Toggle zoom'],
  ['Space + drag', 'Pan'],
  ['Tab', 'Hide side panels'],
  ['Esc', 'Leave the current tool'],
  ['?', 'This list'],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard Shortcuts" onClose={onClose} width={520}>
      <dl className="shortcut-list">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

function ConfirmDialog(p: ConfirmProps & { onClose: () => void }) {
  const cancel = () => {
    p.onClose();
    p.onCancel?.();
  };
  return (
    <Modal
      title={p.title}
      onClose={cancel}
      width={420}
      footer={
        <>
          <button onClick={cancel}>Cancel</button>
          <button
            className={p.danger ? 'danger' : 'primary'}
            autoFocus
            onClick={() => {
              p.onClose();
              p.onConfirm();
            }}
          >
            {p.confirmLabel}
          </button>
        </>
      }
    >
      <p>{p.message}</p>
    </Modal>
  );
}
