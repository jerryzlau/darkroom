import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { imageMenu, openInDevelop } from '../../lib/imageActions';
import { startImport, startImportFiles } from '../../lib/shortcuts';
import { backend } from '../../ipc/backend';
import type { ImageRow } from '../../ipc/types';
import { useLibrary } from '../../state/library';
import { colorOf, Stars, useContextMenu } from '../ui';

const GAP = 8;
const CAPTION = 30;

export function Grid() {
  const images = useLibrary((s) => s.images);
  const thumbSize = useLibrary((s) => s.thumbSize);
  const selected = useLibrary((s) => s.selected);
  const activeId = useLibrary((s) => s.activeId);
  const loaded = useLibrary((s) => s.loaded);
  const select = useLibrary((s) => s.select);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const menu = useContextMenu();

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const inner = size.w - GAP * 2;
  const cols = Math.max(1, Math.floor((inner + GAP) / (thumbSize + GAP)));
  const cellW = (inner - GAP * (cols - 1)) / cols;
  const cellH = cellW + CAPTION;
  const rows = Math.ceil(images.length / cols);
  const total = rows * (cellH + GAP) + GAP;
  const r0 = Math.max(0, Math.floor(scrollTop / (cellH + GAP)) - 2);
  const r1 = Math.min(rows, Math.ceil((scrollTop + size.h) / (cellH + GAP)) + 2);

  // keep the active image visible
  useEffect(() => {
    const el = ref.current;
    if (!el || activeId == null) return;
    const i = images.findIndex((x) => x.id === activeId);
    if (i < 0) return;
    const top = Math.floor(i / cols) * (cellH + GAP) + GAP;
    if (top < el.scrollTop) el.scrollTop = top - GAP;
    else if (top + cellH > el.scrollTop + el.clientHeight) el.scrollTop = top + cellH - el.clientHeight + GAP;
  }, [activeId, cols, cellH, images]);

  const cells: React.ReactNode[] = [];
  for (let r = r0; r < r1; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= images.length) break;
      const img = images[i];
      cells.push(
        <Cell
          key={img.id}
          img={img}
          index={i}
          left={GAP + c * (cellW + GAP)}
          top={GAP + r * (cellH + GAP)}
          w={cellW}
          h={cellH}
          selected={selected.has(img.id)}
          active={img.id === activeId}
          onClick={(e) => select(img.id, e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'single')}
          onDouble={() => openInDevelop(img.id)}
          onMenu={(e) => {
            if (!selected.has(img.id)) select(img.id);
            menu.open(e, imageMenu(img.id));
          }}
        />,
      );
    }
  }

  return (
    <div className="grid" ref={ref} onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)} tabIndex={-1}>
      <div style={{ height: total, position: 'relative' }}>{cells}</div>
      {loaded && images.length === 0 && <EmptyState />}
      {menu.node}
    </div>
  );
}

function EmptyState() {
  const q = useLibrary((s) => s.query);
  const folders = useLibrary((s) => s.folders);
  if (folders.length === 0) {
    return (
      <div className="grid-empty">
        <h2>Welcome to Darkroom</h2>
        <p>Import a folder or a few photos to get started. Your originals are never modified; edits are stored in the catalog.</p>
        <div className="grid-empty-actions">
          <button className="primary big" onClick={() => void startImport()}>
            Import Folder…
          </button>
          <button className="big" onClick={() => void startImportFiles()}>
            Import Files…
          </button>
        </div>
        <p className="hint">Supports RAW files from most cameras, DNG, JPEG, HEIC, PNG, TIFF and WebP.</p>
      </div>
    );
  }
  return (
    <div className="grid-empty">
      <p>No photos match {q.source === 'all' ? 'the current filter' : 'this source and filter'}.</p>
    </div>
  );
}

function Cell(props: {
  img: ImageRow;
  index: number;
  left: number;
  top: number;
  w: number;
  h: number;
  selected: boolean;
  active: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDouble: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const { img } = props;
  const setRating = useLibrary((s) => s.setRating);
  const url = backend().thumbUrl(img.id, img.thumbRev);
  const label = colorOf(img.colorLabel);
  return (
    <div
      className={`cell ${props.selected ? 'selected' : ''} ${props.active ? 'active' : ''} ${img.flag === -1 ? 'rejected' : ''}`}
      style={{ left: props.left, top: props.top, width: props.w, height: props.h }}
      onMouseDown={props.onClick}
      onDoubleClick={props.onDouble}
      onContextMenu={props.onMenu}
      draggable
      onDragStart={(e) => {
        const lib = useLibrary.getState();
        const ids = lib.selected.has(img.id) ? lib.targetIds() : [img.id];
        e.dataTransfer.setData('application/x-darkroom-images', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className="cell-img" style={{ height: props.w - 8 }}>
        <img src={url} alt={img.filename} loading="lazy" draggable={false} />
        {img.missing && <span className="badge missing" title="File is missing">!</span>}
        {img.edited && <span className="badge edited" title="Edited">±</span>}
        {img.copyName && <span className="badge copy" title={img.copyName}>⧉</span>}
        {img.flag === 1 && <span className="badge flag" title="Picked">⚑</span>}
        {img.flag === -1 && <span className="badge flag rej" title="Rejected">✕</span>}
      </div>
      <div className="cell-caption" style={{ borderBottomColor: label ?? 'transparent' }}>
        <Stars value={img.rating} size="small" onChange={(r) => setRating(r, [img.id])} />
        <span className="cell-name" title={img.path}>
          {img.copyName ? `${img.filename} · ${img.copyName}` : img.filename}
        </span>
      </div>
    </div>
  );
}
