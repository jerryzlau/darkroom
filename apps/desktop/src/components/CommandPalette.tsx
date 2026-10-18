import { useEffect, useMemo, useRef, useState } from 'react';
import { runCommand } from '../lib/commandActions';
import { buildCommands, searchCommands, type Command } from '../lib/commands';
import { useUi } from '../state/ui';

const KIND_LABEL: Record<Command['kind'], string> = { tool: 'Tool', panel: 'Panel', control: 'Control', action: 'Action' };

/** ⌘K command palette: finds any tool, panel, control or action and takes you there. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette onClose={() => useUi.getState().setPalette(false)} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const commands = useMemo(buildCommands, []);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(() => searchCommands(commands, query, 14), [commands, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    // after the overlay unmounts, so focus/scroll land on the app
    requestAnimationFrame(() => runCommand(c));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
    e.stopPropagation();
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search tools">
        <input
          className="palette-input"
          autoFocus
          placeholder="Search tools, panels and actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={results[sel] ? `palette-${results[sel].id}` : undefined}
        />
        <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {results.map((c, i) => (
            <li
              key={c.id}
              id={`palette-${c.id}`}
              data-i={i}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? 'active' : ''}
              onMouseMove={() => i !== sel && setSel(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(c)}
            >
              <span className={`palette-kind ${c.kind}`}>{KIND_LABEL[c.kind]}</span>
              <span className="palette-main">
                <span className="palette-title">{c.title}</span>
                <span className="palette-path">{c.path.join(' › ')}</span>
              </span>
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </li>
          ))}
          {results.length === 0 && <li className="palette-empty">No matching tools</li>}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to go
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
