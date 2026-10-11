import { MAX_PATCHES, type Patch } from '@darkroom/core';
import { useEffect, useState } from 'react';
import { formatPrice, GEMINI_MODELS, IMAGE_SIZES, priceFor, upsampleFactor, type ImageSize } from '../../lib/gemini';
import { patchAssetState } from '../../lib/patchAssets';
import { useDevelop } from '../../state/develop';
import { activeFillTarget, useGenerate } from '../../state/generate';
import { useDialogs } from '../dialogs/dialogState';
import { Seg, Slider } from '../ui';

const PHASE_TEXT: Record<string, string> = {
  rendering: 'Rendering the selection…',
  generating: 'Generating… (this can take 10–30 s)',
  saving: 'Saving…',
};

const modelName = (id: string) => GEMINI_MODELS.find((m) => m.id === id)?.name ?? id;

/** Generate tab of the AI dock: Generative Fill of the active selection. */
export function GeneratePanel() {
  const hasKey = useGenerate((s) => s.hasKey);
  const phase = useGenerate((s) => s.phase);
  const error = useGenerate((s) => s.error);
  const note = useGenerate((s) => s.note);
  const model = useGenerate((s) => s.model);
  const size = useGenerate((s) => s.size);
  const hasSource = useDevelop((s) => !!s.source);
  const tool = useDevelop((s) => s.tool);
  // re-derive the target whenever the selection or fills change
  const params = useDevelop((s) => s.params);
  const activeMaskId = useDevelop((s) => s.activeMaskId);
  useDevelop((s) => s.source);
  const overlayMask = useDevelop((s) => s.view.overlayMask);
  const [draft, setDraft] = useState('');
  const [, bump] = useState(0);

  const target = activeFillTarget();
  const reason = target && 'reason' in target ? target.reason : null;
  const ready = target && !('reason' in target) ? target : null;
  const existing = ready?.existing;
  const busy = phase !== 'idle';
  const patches = params.patches;
  const others = patches.filter((p) => p.maskId !== activeMaskId || activeMaskId == null);

  // re-render once a fill's image data loads (or turns out missing)
  const existingAsset = existing?.asset;
  useEffect(() => {
    if (!existingAsset || patchAssetState(existingAsset) !== 'loading') return;
    const t = setInterval(() => {
      if (patchAssetState(existingAsset) !== 'loading') {
        clearInterval(t);
        bump((n) => n + 1);
      }
    }, 300);
    return () => clearInterval(t);
  }, [existingAsset]);

  if (hasKey === false) {
    return (
      <div className="ai-empty">
        <p>Select part of the photo and describe what should be there instead. A Google Gemini image model (Nano Banana) redraws only that area.</p>
        <p className="hint">Add a Google AI API key in Settings. Image output needs a paid key.</p>
        <button onClick={() => useDialogs.getState().open('settings')}>Open Settings…</button>
      </div>
    );
  }

  const canGenerate =
    !!draft.trim() && !busy && hasSource && !!ready && (!!existing || patches.length < MAX_PATCHES);
  const go = async () => {
    if (!canGenerate) return;
    const ok = await useGenerate.getState().generate(draft);
    if (ok) setDraft('');
  };
  const price = priceFor(model, size);
  const upsample = ready ? upsampleFactor(ready.plan.px, size) : 1;
  const overlayOn = target != null && overlayMask === target.index;

  return (
    <>
      <div className="ai-messages generate">
        {!hasSource ? (
          <div className="ai-placeholder">Open a photo to use Generative Fill.</div>
        ) : (
          <>
            {target ? (
              <>
                <div className="ai-scope">
                  <span className={`chip ${overlayOn ? 'on' : ''}`} title="Show or hide the selection overlay">
                    <button
                      className="ai-scope-name"
                      onClick={() =>
                        useDevelop.getState().setView({ overlayMask: overlayOn ? -1 : target.index, overlayInvert: target.mask.invert })
                      }
                    >
                      Filling: {target.mask.name}
                    </button>
                    <button
                      className="chip-x"
                      title="Deselect"
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
                {reason && <div className="ai-error">{reason}</div>}
              </>
            ) : (
              <div className="ai-placeholder">
                Draw a selection with the Select tool (S) around the thing to replace, then describe the change.
                {tool !== 'select' && (
                  <div>
                    <button onClick={() => useDevelop.getState().setTool('select')}>Select tool</button>
                  </div>
                )}
              </div>
            )}
            {existing && <FillCard patch={existing} busy={busy} />}
            {ready && !existing && patches.length >= MAX_PATCHES && <div className="hint">Up to {MAX_PATCHES} fills per photo.</div>}
            {others.length > 0 && (
              <div className="gen-list">
                <div className="gen-meta">Other fills on this photo</div>
                {others.map((p) => (
                  <OtherFill key={p.id} patch={p} maskName={params.masks.find((m) => m.id === p.maskId)?.name ?? null} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {hasSource && (
        <div className="ai-compose gen-foot">
          <textarea
            rows={2}
            value={draft}
            placeholder={ready ? `What should be in “${ready.mask.name}”?` : 'Select an area first'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void go();
              }
            }}
          />
          <div className="gen-row">
            <select value={model} onChange={(e) => void useGenerate.getState().setModel(e.target.value)} title="Image model">
              {!GEMINI_MODELS.some((m) => m.id === model) && <option value={model}>{model}</option>}
              {GEMINI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="gen-price" title="Approximate price per generated image">
              ~{formatPrice(price ?? 0)}
            </span>
          </div>
          <div className="gen-row">
            <Seg<ImageSize>
              small
              value={size}
              options={IMAGE_SIZES.map((s) => ({ value: s, label: s, title: `${s} output` }))}
              onChange={(s) => useGenerate.getState().setSize(s)}
            />
            <span className="spacer" />
            {busy ? (
              <button onClick={() => useGenerate.getState().stop()}>Stop</button>
            ) : (
              <button className="primary" disabled={!canGenerate} onClick={() => void go()}>
                Generate
              </button>
            )}
          </div>
          {busy && <div className="ai-status">{PHASE_TEXT[phase]}</div>}
          {error && <div className="ai-error">{error}</div>}
          {note && !busy && <div className="hint">{note}</div>}
          {ready && upsample > 1.15 && (
            <div className="hint">
              This area is {upsample.toFixed(1)}× larger than a {size} output; choose {size === '4K' ? 'a smaller selection' : size === '2K' ? '4K' : '2K or 4K'} for a sharper fill.
            </div>
          )}
          <div className="hint">
            Generated pixels carry Google's SynthID watermark. Reshape the selection and regenerate to change the area.
          </div>
        </div>
      )}
    </>
  );
}

function FillCard({ patch, busy }: { patch: Patch; busy: boolean }) {
  const g = useGenerate.getState;
  const missing = patchAssetState(patch.asset) === 'missing';
  return (
    <div className="gen-card">
      <div className="gen-prompt">“{patch.prompt}”</div>
      <div className="gen-meta">{modelName(patch.model)}</div>
      <Slider
        label="Opacity"
        value={Math.round(patch.opacity * 100)}
        min={0}
        max={100}
        step={1}
        defaultValue={100}
        onChange={(v) => g().setOpacity(patch.id, v / 100, false)}
        onCommit={() => {
          const cur = useDevelop.getState().params.patches.find((x) => x.id === patch.id);
          if (cur) g().setOpacity(patch.id, cur.opacity, true);
        }}
      />
      <label className="check">
        <input type="checkbox" checked={patch.enabled} onChange={(e) => g().setEnabled(patch.id, e.target.checked)} />
        Enabled
      </label>
      {missing && <div className="ai-error">The image data for this fill is missing. Regenerate it.</div>}
      <div className="btn-row">
        <button disabled={busy} onClick={() => void g().regenerate(patch.id)}>
          Regenerate
        </button>
        <button disabled={busy} onClick={() => g().remove(patch.id)}>
          Remove
        </button>
      </div>
    </div>
  );
}

function OtherFill({ patch, maskName }: { patch: Patch; maskName: string | null }) {
  return (
    <div className="gen-item">
      <span>{maskName ?? 'deleted selection'}</span>
      <span className="gen-prompt" title={patch.prompt}>
        {patch.prompt}
      </span>
      {maskName != null && patch.maskId && (
        <button className="small" onClick={() => useDevelop.getState().setActiveMask(patch.maskId)}>
          Select
        </button>
      )}
      <button className="small" onClick={() => useGenerate.getState().remove(patch.id)}>
        Remove
      </button>
    </div>
  );
}
