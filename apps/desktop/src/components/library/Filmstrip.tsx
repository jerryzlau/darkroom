import { useEffect, useRef, useState } from 'react';
import { imageMenu } from '../../lib/imageActions';
import { backend } from '../../ipc/backend';
import { useLibrary } from '../../state/library';
import { colorOf, useContextMenu } from '../ui';

const H = 84;

export function Filmstrip() {
  const images = useLibrary((s) => s.images);
  const selected = useLibrary((s) => s.selected);
  const activeId = useLibrary((s) => s.activeId);
  const select = useLibrary((s) => s.select);
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [width, setWidth] = useState(1000);
  const menu = useContextMenu();
  const cell = H - 8;

  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    const i = images.findIndex((x) => x.id === activeId);
    if (!el || i < 0) return;
    const left = i * (cell + 4);
    if (left < el.scrollLeft || left + cell > el.scrollLeft + el.clientWidth) el.scrollTo({ left: left - el.clientWidth / 2 + cell / 2, behavior: 'smooth' });
  }, [activeId, images, cell]);

  const i0 = Math.max(0, Math.floor(scroll / (cell + 4)) - 4);
  const i1 = Math.min(images.length, Math.ceil((scroll + width) / (cell + 4)) + 4);
  return (
    <div
      className="filmstrip"
      ref={ref}
      onScroll={(e) => setScroll((e.target as HTMLElement).scrollLeft)}
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) (e.currentTarget as HTMLElement).scrollLeft += e.deltaY;
      }}
    >
      <div style={{ width: images.length * (cell + 4), height: cell, position: 'relative' }}>
        {images.slice(i0, i1).map((img, k) => {
          const i = i0 + k;
          const label = colorOf(img.colorLabel);
          return (
            <div
              key={img.id}
              className={`film-cell ${selected.has(img.id) ? 'selected' : ''} ${img.id === activeId ? 'active' : ''} ${img.flag === -1 ? 'rejected' : ''}`}
              style={{ left: i * (cell + 4), width: cell, height: cell, borderBottomColor: label ?? undefined }}
              onMouseDown={(e) => select(img.id, e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'single')}
              onContextMenu={(e) => menu.open(e, imageMenu(img.id))}
              title={`${img.filename}${img.rating ? `  ${'★'.repeat(img.rating)}` : ''}`}
            >
              <img src={backend().thumbUrl(img.id, img.thumbRev)} alt="" loading="lazy" draggable={false} />
              {img.edited && <span className="badge edited small">±</span>}
            </div>
          );
        })}
      </div>
      {menu.node}
    </div>
  );
}
