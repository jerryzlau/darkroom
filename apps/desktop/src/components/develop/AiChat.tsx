import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAiChat } from '../../state/aiChat';
import { useDevelop } from '../../state/develop';
import { useUi } from '../../state/ui';
import { useDialogs } from '../dialogs/dialogState';
import { GuidedPanel } from './GuidedPanel';
import { useGuided } from '../../state/guided';
import { useGenerate } from '../../state/generate';
import { GeneratePanel } from './GeneratePanel';

/** Collapsible AI Edit dock (chat / guided / generate), pinned to the bottom of the Develop right column. */
export function AiDock() {
  const open = useUi((s) => s.aiOpen);
  const toggleAi = useUi((s) => s.toggleAi);
  const tab = useUi((s) => s.aiTab);
  const setAiTab = useUi((s) => s.setAiTab);
  const status = useAiChat((s) => s.status);
  const hasKey = useAiChat((s) => s.hasKey);
  const hasRows = useAiChat((s) => s.display.length > 0);
  const guidedPhase = useGuided((s) => s.phase);
  const genPhase = useGenerate((s) => s.phase);

  useEffect(() => {
    void useAiChat.getState().refreshKey();
    void useGenerate.getState().refreshKey();
    return useDialogs.subscribe((s, prev) => {
      if (prev.name === 'settings' && s.name !== 'settings') {
        void useAiChat.getState().refreshKey();
        void useGenerate.getState().refreshKey();
      }
    });
  }, []);

  const streaming = status === 'streaming';
  const busy = streaming || guidedPhase === 'analyzing' || genPhase !== 'idle';
  return (
    <section className={`ai-dock ${open ? 'open' : ''}`} data-section="ai">
      <header className="ai-head" onClick={() => toggleAi()} title="AI Edit (⌘J)">
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="title">AI Edit</span>
        {busy && <span className="ai-busy" title="Working…" />}
        {open && (
          <span className="ai-tabs" onClick={(e) => e.stopPropagation()}>
            <button className={tab === 'chat' ? 'active' : ''} onClick={() => setAiTab('chat')}>
              Chat
            </button>
            <button className={tab === 'guided' ? 'active' : ''} onClick={() => setAiTab('guided')}>
              Guided
            </button>
            <button className={tab === 'generate' ? 'active' : ''} onClick={() => setAiTab('generate')}>
              Generate
            </button>
          </span>
        )}
        <span className="spacer" />
        {open && hasKey && tab === 'chat' && (
          <button
            className="icon-btn small"
            title="New chat"
            disabled={!hasRows && !streaming}
            onClick={(e) => {
              e.stopPropagation();
              useAiChat.getState().clear();
            }}
          >
            ＋
          </button>
        )}
        {open && hasKey && tab === 'guided' && (
          <button
            className="icon-btn small"
            title="Start over"
            disabled={guidedPhase === 'idle'}
            onClick={(e) => {
              e.stopPropagation();
              useGuided.getState().reset();
            }}
          >
            ↺
          </button>
        )}
      </header>
      {open && (tab === 'generate' ? <GeneratePanel /> : hasKey === false ? <NoKey /> : hasKey ? tab === 'guided' ? <GuidedPanel /> : <Chat /> : null)}
    </section>
  );
}

function NoKey() {
  return (
    <div className="ai-empty">
      <p>Describe an edit in plain words and Claude adjusts the sliders for you.</p>
      <p className="hint">Add an Anthropic API key in Settings to turn this on. Nothing is sent until you send a message or start a guided edit.</p>
      <button onClick={() => useDialogs.getState().open('settings')}>Open Settings…</button>
    </div>
  );
}

function Chat() {
  const rows = useAiChat((s) => s.display);
  const status = useAiChat((s) => s.status);
  const hasSource = useDevelop((s) => !!s.source);
  const scope = useDevelop(useShallow((s) => {
    const i = s.params.masks.findIndex((m) => m.id === s.activeMaskId);
    return i >= 0 ? { index: i, name: s.params.masks[i].name, invert: s.params.masks[i].invert } : null;
  }));
  const overlayOn = useDevelop((s) => scope != null && s.view.overlayMask === scope.index);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const streaming = status === 'streaming';

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const send = () => {
    if (!draft.trim() || streaming || !hasSource) return;
    void useAiChat.getState().send(draft);
    setDraft('');
    nearBottom.current = true;
  };

  return (
    <>
      <div
        className="ai-messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {rows.length === 0 && (
          <div className="ai-placeholder">
            {hasSource ? (
              <>
                Try “warmer, lift the shadows a little, add some grain”.
                <br />
                Draw a selection (S) to edit just one area.
              </>
            ) : (
              'Open a photo to start editing with AI.'
            )}
          </div>
        )}
        {rows.map((r) => (
          <div key={r.id} className={`ai-msg ${r.role}`}>
            {r.text && <div className="ai-text">{r.text}</div>}
            {r.patches?.map((p, i) => (
              <div key={i} className="ai-patch">
                ✓ {p}
              </div>
            ))}
            {r.busy && (r.phase === 'adjusting' || !r.text) && (
              <div className="ai-status">{r.phase === 'adjusting' ? 'Adjusting settings…' : 'Thinking…'}</div>
            )}
            {r.error && <div className="ai-error">{r.error}</div>}
          </div>
        ))}
      </div>
      {hasSource && scope && (
        <div className="ai-scope">
          <span className={`chip ${overlayOn ? 'on' : ''}`} title="Show or hide the selection overlay">
            <button
              className="ai-scope-name"
              onClick={() => useDevelop.getState().setView({ overlayMask: overlayOn ? -1 : scope.index, overlayInvert: scope.invert })}
            >
              Editing: {scope.name}
            </button>
            <button
              className="chip-x"
              title="Edit the whole photo instead"
              onClick={() => {
                const d = useDevelop.getState();
                d.setActiveMask(null);
                if (overlayOn) d.setView({ overlayMask: -1 });
              }}
            >
              ✕
            </button>
          </span>
        </div>
      )}
      <div className="ai-compose">
        <textarea
          rows={2}
          value={draft}
          placeholder={hasSource ? (scope ? `Describe a change to “${scope.name}”…` : 'Describe an edit…') : 'Open a photo first'}
          disabled={!hasSource}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {streaming ? (
          <button onClick={() => useAiChat.getState().stop()}>Stop</button>
        ) : (
          <button className="primary" disabled={!draft.trim() || !hasSource} onClick={send}>
            Send
          </button>
        )}
      </div>
    </>
  );
}
