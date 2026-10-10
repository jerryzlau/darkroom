import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  format?: (v: number) => string;
  parse?: (s: string) => number;
  /** CSS background for the track (e.g. temperature gradient) */
  track?: string;
  /** Map between value and 0..1 position (for non-linear sliders) */
  toPos?: (v: number) => number;
  fromPos?: (t: number) => number;
  disabled?: boolean;
  title?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function Slider(p: SliderProps) {
  const { min, max, value, onChange, onCommit } = p;
  const step = p.step ?? 1;
  const def = p.defaultValue ?? (min < 0 && max > 0 ? 0 : min);
  const toPos = p.toPos ?? ((v: number) => (v - min) / (max - min));
  const fromPos = p.fromPos ?? ((t: number) => min + t * (max - min));
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startPos: number; fine: boolean } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  const snap = useCallback(
    (v: number) => {
      const s = Math.round(v / step) * step;
      return clamp(Number(s.toFixed(6)), min, max);
    },
    [step, min, max],
  );

  const setFromClientX = (clientX: number, fine: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (drag.current) {
      const dx = (clientX - drag.current.startX) / r.width;
      const t = clamp(drag.current.startPos + dx * (fine ? 0.1 : 1), 0, 1);
      onChange(snap(fromPos(t)));
    } else {
      onChange(snap(fromPos(clamp((clientX - r.left) / r.width, 0, 1))));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (p.disabled || e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const el = trackRef.current!;
    const r = el.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1);
    // clicking the thumb keeps the value; clicking the track jumps
    const thumbX = r.left + toPos(value) * r.width;
    const onThumb = Math.abs(e.clientX - thumbX) < 8;
    if (!onThumb) onChange(snap(fromPos(t)));
    drag.current = { startX: e.clientX, startPos: onThumb ? toPos(value) : t, fine: e.shiftKey };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    if (e.shiftKey !== drag.current.fine) {
      // re-anchor when toggling fine mode so the value doesn't jump
      drag.current = { startX: e.clientX, startPos: toPos(value), fine: e.shiftKey };
    }
    setFromClientX(e.clientX, e.shiftKey);
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    onCommit?.();
  };

  const reset = () => {
    if (p.disabled) return;
    onChange(def);
    setTimeout(() => onCommit?.(), 0);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (p.disabled || !e.altKey) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    onChange(snap(value + dir * step * (e.shiftKey ? 10 : 1)));
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => onCommit?.(), 400);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1;
      onChange(snap(value + dir * step * (e.shiftKey ? 10 : 1)));
    }
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key.startsWith('Arrow')) onCommit?.();
  };

  const fmt = p.format ?? ((v: number) => (step < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v))));
  const pos = clamp(toPos(value), 0, 1);
  const zero = clamp(toPos(clamp(def, min, max)), 0, 1);
  const bipolar = min < 0 && max > 0 && !p.track;

  const commitText = () => {
    setEditing(false);
    const v = p.parse ? p.parse(text) : parseFloat(text);
    if (Number.isFinite(v)) {
      onChange(snap(v));
      setTimeout(() => onCommit?.(), 0);
    }
  };

  return (
    <div className={`slider ${p.disabled ? 'disabled' : ''}`} onWheel={onWheel} title={p.title}>
      <div className="slider-head">
        <label onDoubleClick={reset} title="Double-click to reset">
          {p.label}
        </label>
        {editing ? (
          <input
            className="slider-input"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitText();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span
            className={`slider-value ${value !== def ? 'changed' : ''}`}
            onClick={() => {
              if (p.disabled) return;
              setText(fmt(value));
              setEditing(true);
            }}
          >
            {fmt(value)}
          </span>
        )}
      </div>
      <div
        className="slider-track"
        ref={trackRef}
        tabIndex={p.disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        role="slider"
        aria-label={p.label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <div className="slider-rail" style={p.track ? { background: p.track } : undefined} />
        {bipolar && (
          <div
            className="slider-fill"
            style={{ left: `${Math.min(pos, zero) * 100}%`, width: `${Math.abs(pos - zero) * 100}%` }}
          />
        )}
        {!bipolar && !p.track && <div className="slider-fill" style={{ left: 0, width: `${pos * 100}%` }} />}
        <div className="slider-thumb" style={{ left: `${pos * 100}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible panel section
// ---------------------------------------------------------------------------

export function Section(props: {
  id: string;
  title: string;
  children: ReactNode;
  onReset?: () => void;
  defaultOpen?: boolean;
  right?: ReactNode;
  changed?: boolean;
}) {
  const key = `darkroom.section.${props.id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? (props.defaultOpen ?? true) : v === '1';
    } catch {
      return props.defaultOpen ?? true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [open, key]);
  return (
    <section className={`panel-section ${open ? 'open' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="title">
          {props.title}
          {props.changed && <span className="dot-changed" title="Edited" />}
        </span>
        <span className="spacer" />
        {props.right}
        {props.onReset && (
          <button
            className="icon-btn small"
            title={`Reset ${props.title}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onReset!();
            }}
          >
            ↺
          </button>
        )}
      </header>
      {open && <div className="panel-body">{props.children}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Misc controls
// ---------------------------------------------------------------------------

export function Seg<T extends string | number>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`seg ${props.small ? 'small' : ''}`}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          className={o.value === props.value ? 'active' : ''}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stars(props: { value: number; onChange?: (v: number) => void; size?: 'small' | 'normal' }) {
  return (
    <span className={`stars ${props.size ?? 'normal'}`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={i <= props.value ? 'on' : ''}
          onClick={(e) => {
            if (!props.onChange) return;
            e.stopPropagation();
            props.onChange(props.value === i ? 0 : i);
          }}
        >
          ★
        </span>
      ))}
    </span>
  );
}

export const COLOR_LABELS = [
  { id: 'red', color: '#d9534f', key: '6' },
  { id: 'yellow', color: '#e8c547', key: '7' },
  { id: 'green', color: '#5cb85c', key: '8' },
  { id: 'blue', color: '#4a8fd9', key: '9' },
  { id: 'purple', color: '#9b6bd1', key: '' },
];

export function colorOf(label: string) {
  return COLOR_LABELS.find((c) => c.id === label)?.color;
}

export function ColorDots(props: { value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <span className="color-dots">
      {COLOR_LABELS.map((c) => (
        <span
          key={c.id}
          className={`cdot ${props.value === c.id ? 'active' : ''}`}
          style={{ background: c.color }}
          title={`${c.id}${c.key ? ` (${c.key})` : ''}`}
          onClick={() => props.onChange(props.value === c.id ? '' : c.id)}
        />
      ))}
    </span>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={{ width: props.width ?? 480 }} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  shortcut?: string;
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const node = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open, node };
}

function ContextMenu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(props.x, window.innerWidth - r.width - 8), y: Math.min(props.y, window.innerHeight - r.height - 8) });
    }
    const close = () => props.onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [props]);
  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {props.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="sep" />
        ) : (
          <button
            key={i}
            disabled={it.disabled}
            className={it.danger ? 'danger' : ''}
            onClick={() => {
              props.onClose();
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
