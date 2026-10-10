import { useEffect, useState } from 'react';
import { backend } from '../../ipc/backend';
import { useLibrary } from '../../state/library';
import { toast } from '../../state/toast';
import { ColorDots, Section, Stars } from '../ui';

function fmtSize(b: number) {
  if (b > 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}

export function MetadataPanel() {
  const activeId = useLibrary((s) => s.activeId);
  const img = useLibrary((s) => s.images.find((i) => i.id === s.activeId));
  const selectedCount = useLibrary((s) => s.selected.size);
  const lib = useLibrary.getState;
  const [keywords, setKeywords] = useState<string[]>([]);
  const [kw, setKw] = useState('');
  useEffect(() => {
    if (!img) return setKeywords([]);
    backend().getKeywords(img.photoId).then(setKeywords).catch(() => setKeywords([]));
  }, [img?.photoId, activeId]);

  if (!img) return <div className="panel-empty">No photo selected</div>;

  const photoIds = () => {
    const ids = lib().targetIds();
    return [...new Set(lib().images.filter((i) => ids.includes(i.id)).map((i) => i.photoId))];
  };
  const addKeyword = async () => {
    const names = kw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    await backend().addKeywords(photoIds(), names);
    setKw('');
    setKeywords(await backend().getKeywords(img.photoId));
    void lib().refreshSidebar();
  };

  const rows: [string, string | null | undefined][] = [
    ['File', img.filename + (img.copyName ? ` (${img.copyName})` : '')],
    ['Folder', img.path.replace(/\/[^/]+$/, '').replace(/^\/Users\/[^/]+/, '~')],
    ['Captured', img.capturedAt ? new Date(img.capturedAt).toLocaleString() : null],
    ['Dimensions', img.width ? `${img.width} × ${img.height}` : null],
    ['Size', img.fileSize ? fmtSize(img.fileSize) : null],
    ['Type', img.format.toUpperCase()],
    ['Camera', [img.make, img.model].filter(Boolean).join(' ') || null],
    ['Lens', img.lens],
    ['Focal length', img.focalLength ? `${Math.round(img.focalLength)} mm` : null],
    ['Aperture', img.fnumber ? `ƒ/${img.fnumber.toFixed(1)}` : null],
    ['Shutter', img.exposureTime],
    ['ISO', img.iso ? String(img.iso) : null],
    ['GPS', img.gpsLat != null && img.gpsLon != null ? `${img.gpsLat.toFixed(5)}, ${img.gpsLon.toFixed(5)}` : null],
  ];

  return (
    <>
      <Section id="lib-info" title={selectedCount > 1 ? `Metadata · ${selectedCount} selected` : 'Metadata'}>
        <div className="row">
          <span className="row-label">Rating</span>
          <Stars value={img.rating} onChange={(r) => lib().setRating(r)} />
        </div>
        <div className="row">
          <span className="row-label">Flag</span>
          <span className="flag-btns">
            <button className={img.flag === 1 ? 'active' : ''} onClick={() => lib().setFlag(img.flag === 1 ? 0 : 1)} title="Pick (P)">
              ⚑ Pick
            </button>
            <button className={img.flag === -1 ? 'active' : ''} onClick={() => lib().setFlag(img.flag === -1 ? 0 : -1)} title="Reject (X)">
              ✕ Reject
            </button>
          </span>
        </div>
        <div className="row">
          <span className="row-label">Label</span>
          <ColorDots value={img.colorLabel} onChange={(c) => lib().setColorLabel(c)} />
        </div>
        <dl className="meta-list">
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd title={v ?? ''}>{v}</dd>
              </div>
            ))}
        </dl>
        {img.missing && <div className="warn-box">The original file is missing. Synchronize its folder or check the drive.</div>}
        <div className="btn-row">
          <button onClick={() => backend().revealInFinder(img.path)}>Show in Finder</button>
          <button
            onClick={async () => {
              const n = await backend().writeSidecars(lib().targetIds());
              toast(`Wrote ${n} XMP sidecar${n === 1 ? '' : 's'}`);
            }}
          >
            Save XMP
          </button>
        </div>
      </Section>
      <Section id="lib-keywords" title="Keywords">
        <div className="keyword-chips">
          {keywords.map((k) => (
            <span key={k} className="chip">
              {k}
              <button
                className="chip-x"
                onClick={async () => {
                  await backend().removeKeyword(photoIds(), k);
                  setKeywords(await backend().getKeywords(img.photoId));
                  void lib().refreshSidebar();
                }}
              >
                ✕
              </button>
            </span>
          ))}
          {!keywords.length && <span className="hint">No keywords</span>}
        </div>
        <div className="row">
          <input
            className="search"
            placeholder="Add keywords (comma separated)"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void addKeyword();
            }}
          />
        </div>
      </Section>
    </>
  );
}
