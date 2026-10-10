import { useEffect, useState } from 'react';
import { guidedFilter, guidedSummary, useGuided, type GuidedRound } from '../../state/guided';
import { useDevelop } from '../../state/develop';
import { useDialogs } from '../dialogs/dialogState';

/** Guided Edit tab of the AI dock: round-by-round options picked by the user. */
export function GuidedPanel() {
  const phase = useGuided((s) => s.phase);
  const error = useGuided((s) => s.error);
  const rounds = useGuided((s) => s.rounds);
  const hasSource = useDevelop((s) => !!s.source);

  // leaving the tab or collapsing the dock drops any canvas preview
  useEffect(
    () => () => {
      if (useGuided.getState().previewing != null) useGuided.getState().preview(null);
    },
    [],
  );

  const current = phase === 'choosing' ? rounds[rounds.length - 1] : undefined;
  const past = current ? rounds.slice(0, -1) : rounds;

  return (
    <>
      <div className="ai-messages guided">
        {phase === 'idle' ? (
          <div className="ai-placeholder">
            {hasSource
              ? 'Claude looks at the photo and suggests a few directions, one aspect at a time. Pick the one you like; the result can be saved as a filter.'
              : 'Open a photo to start a guided edit.'}
          </div>
        ) : (
          <>
            <Assessment />
            {past.map((r) => (
              <RoundSummary key={r.index} round={r} />
            ))}
            {phase === 'analyzing' && (
              <div className="ai-status">{rounds.length === 0 ? 'Looking at the photo…' : `Proposing round ${rounds.length + 1}…`}</div>
            )}
            {current && <CurrentRound round={current} />}
            {phase === 'done' && <DoneSummary />}
          </>
        )}
        {error && <div className="ai-error">{error}</div>}
      </div>
      <Footer />
    </>
  );
}

function Assessment() {
  const assessment = useGuided((s) => s.assessment);
  const many = useGuided((s) => s.rounds.length > 1);
  const [open, setOpen] = useState<boolean | null>(null);
  if (!assessment) return null;
  const shown = !many || (open ?? false);
  return (
    <div className="guided-assessment">
      {many && (
        <button className="guided-toggle" onClick={() => setOpen(!shown)}>
          {shown ? '▾' : '▸'} Assessment
        </button>
      )}
      {shown && <div className="ai-text">{assessment}</div>}
    </div>
  );
}

function RoundSummary({ round }: { round: GuidedRound }) {
  const picked = typeof round.choice === 'number' ? round.options[round.choice]?.title : null;
  return (
    <div className="guided-past">
      Round {round.index + 1} · {round.aspect} — {picked ? <>chosen: <b>{picked}</b></> : 'skipped'}
    </div>
  );
}

function CurrentRound({ round }: { round: GuidedRound }) {
  const previewing = useGuided((s) => s.previewing);
  const g = useGuided.getState;
  return (
    <div className="guided-round">
      <div className="guided-round-head">
        Round {round.index + 1} · {round.aspect}
      </div>
      {round.options.map((o) => (
        <div
          key={o.id}
          className={`guided-option ${previewing === o.id ? 'previewing' : ''}`}
          onMouseEnter={() => g().preview(o.id)}
          onMouseLeave={() => g().preview(null)}
        >
          <div
            className={`guided-thumb ${o.thumb ? '' : 'loading'}`}
            title="Preview on the photo"
            onClick={() => g().preview(g().previewing === o.id ? null : o.id)}
          >
            {o.thumb && <img src={o.thumb} alt={o.title} draggable={false} />}
          </div>
          <div className="guided-option-body">
            <div className="guided-title">{o.title}</div>
            {o.why && <div className="guided-why">{o.why}</div>}
          </div>
          <button className="guided-choose" onClick={() => void g().choose(o.id)}>
            Choose
          </button>
        </div>
      ))}
    </div>
  );
}

function DoneSummary() {
  const doneReason = useGuided((s) => s.doneReason);
  useGuided((s) => s.rounds); // re-render when picks change
  const { picks } = guidedSummary();
  return (
    <div className="guided-done">
      <div className="guided-round-head">Result</div>
      {picks.length ? (
        <ul className="guided-picks">
          {picks.map((p, i) => (
            <li key={i}>
              {p.aspect} → <b>{p.title}</b>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ai-placeholder">No changes were picked.</div>
      )}
      {doneReason && <div className="ai-status">{doneReason}</div>}
    </div>
  );
}

function Footer() {
  const phase = useGuided((s) => s.phase);
  const lastDone = useGuided((s) => s.rounds[s.rounds.length - 1]?.done ?? false);
  const hasSource = useDevelop((s) => !!s.source);
  // the filter depends on committed params; subscribe so the button state stays fresh
  useDevelop((s) => s.committed);
  const g = useGuided.getState;

  if (phase === 'idle') {
    return (
      <div className="ai-compose guided-foot">
        <span className="spacer" />
        <button className="primary" disabled={!hasSource} onClick={() => void g().start()}>
          Analyze photo
        </button>
      </div>
    );
  }
  if (phase === 'analyzing') {
    return (
      <div className="ai-compose guided-foot">
        <span className="spacer" />
        <button onClick={() => g().stop()}>Stop</button>
      </div>
    );
  }
  if (phase === 'choosing') {
    return (
      <div className="ai-compose guided-foot">
        <button onClick={() => void g().skip()}>Skip</button>
        <span className="spacer" />
        <button className={lastDone ? 'primary' : ''} onClick={() => g().finish()}>
          Finish
        </button>
      </div>
    );
  }
  const f = guidedFilter();
  return (
    <div className="ai-compose guided-foot">
      <button onClick={() => g().reset()}>Start over</button>
      <span className="spacer" />
      <button
        className="primary"
        disabled={!f || f.sections.length === 0}
        onClick={() => {
          const filter = guidedFilter();
          if (!filter) return;
          useDialogs.getState().open('savePreset', {
            name: '',
            group: 'User Presets',
            description: guidedSummary().description,
            sections: filter.sections,
            fromParams: useDevelop.getState().committed,
            source: 'ai',
            excludeExposure: true,
          });
        }}
      >
        Save as filter…
      </button>
    </div>
  );
}
