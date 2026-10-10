import { useEffect, useState } from 'react';
import { useLibrary } from '../../state/library';
import { COLOR_LABELS, Seg } from '../ui';

export function FilterBar() {
  const q = useLibrary((s) => s.query);
  const setQuery = useLibrary((s) => s.setQuery);
  const count = useLibrary((s) => s.images.length);
  const selected = useLibrary((s) => s.selected.size);
  const [text, setText] = useState(q.text ?? '');
  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.text ?? '') !== text) setQuery({ text });
    }, 250);
    return () => clearTimeout(t);
  }, [text, q.text, setQuery]);
  const active = !!(q.text || q.minRating || (q.flag && q.flag !== 'all') || q.colorLabel || q.format || q.keyword);
  return (
    <div className="filter-bar">
      <input className="search" placeholder="Search filename, camera, keyword…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <span className="fb-group">
        <span className="fb-label">Rating</span>
        <select value={q.ratingOp ?? '>='} onChange={(e) => setQuery({ ratingOp: e.target.value as '>=' })}>
          <option value=">=">≥</option>
          <option value="=">=</option>
          <option value="<=">≤</option>
        </select>
        <span className="stars normal">
          {[1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={i <= (q.minRating ?? 0) ? 'on' : ''} onClick={() => setQuery({ minRating: q.minRating === i ? 0 : i })}>
              ★
            </span>
          ))}
        </span>
      </span>
      <span className="fb-group">
        <Seg
          small
          value={q.flag ?? 'all'}
          options={[
            { value: 'all', label: 'All' },
            { value: 'picked', label: '⚑', title: 'Picked' },
            { value: 'unflagged', label: '◻', title: 'Unflagged' },
            { value: 'notRejected', label: '¬✕', title: 'Hide rejected' },
            { value: 'rejected', label: '✕', title: 'Rejected' },
          ]}
          onChange={(v) => setQuery({ flag: v })}
        />
      </span>
      <span className="fb-group color-dots">
        {COLOR_LABELS.map((c) => (
          <span
            key={c.id}
            className={`cdot ${q.colorLabel === c.id ? 'active' : ''}`}
            style={{ background: c.color }}
            title={c.id}
            onClick={() => setQuery({ colorLabel: q.colorLabel === c.id ? '' : c.id })}
          />
        ))}
      </span>
      <select value={q.format ?? ''} onChange={(e) => setQuery({ format: e.target.value })} title="File type">
        <option value="">All types</option>
        <option value="raw">Raw</option>
        <option value="jpeg">JPEG</option>
        <option value="heic">HEIC</option>
        <option value="png">PNG</option>
        <option value="tiff">TIFF</option>
      </select>
      {q.keyword && (
        <span className="chip" onClick={() => setQuery({ keyword: '' })} title="Clear keyword filter">
          #{q.keyword} ✕
        </span>
      )}
      {active && (
        <button
          className="link-btn"
          onClick={() => {
            setText('');
            setQuery({ text: '', minRating: 0, flag: 'all', colorLabel: '', format: '', keyword: '' });
          }}
        >
          Clear
        </button>
      )}
      <span className="spacer" />
      <span className="fb-count">
        {selected > 1 ? `${selected} of ` : ''}
        {count} photo{count === 1 ? '' : 's'}
      </span>
    </div>
  );
}
