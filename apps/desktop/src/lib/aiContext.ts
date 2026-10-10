/** Builds the per-turn context for AI Edit: a small render of the photo plus its settings and metadata. */
import type Anthropic from '@anthropic-ai/sdk';
import { MAX_MASKS } from '../engine/shaders';
import { useDevelop } from '../state/develop';
import { compactParams } from './ai';
import { toJpeg } from './background';
import { histogramSummary, renderParamsPixels, toBase64 } from './renderPreview';

const LONG_EDGE = 1024;

/** The active mask, if it is enabled and within the renderer's mask budget. */
function activeSelection() {
  const s = useDevelop.getState();
  const masks = s.committed.masks;
  const index = masks.findIndex((m) => m.id === s.activeMaskId);
  if (index < 0 || index >= MAX_MASKS || !masks[index].enabled) return null;
  return { index, mask: masks[index] };
}

/** Render the committed edit as a JPEG; with overlayIndex >= 0 that mask is tinted red. */
async function renderJpeg(overlayIndex = -1, overlayInvert = false): Promise<{ data: string; px: Uint8Array; w: number; h: number } | null> {
  const r = await renderParamsPixels(useDevelop.getState().committed, LONG_EDGE, { overlayMask: overlayIndex, overlayInvert, cancellable: false });
  if (!r) return null;
  return { data: toBase64(await toJpeg(r.px, r.w, r.h, 0.85)), ...r };
}

function describe(sel: ReturnType<typeof activeSelection>, withOverlay: boolean, histogram: string | null): string {
  const s = useDevelop.getState();
  const img = s.image;
  const lines: string[] = [];
  if (img) {
    lines.push(`File: ${img.filename} (${img.format}, ${img.width}x${img.height})`);
    const cam = [img.make, img.model].filter(Boolean).join(' ');
    if (cam) lines.push(`Camera: ${cam}`);
    if (img.lens) lines.push(`Lens: ${img.lens}`);
    const exp = [
      img.focalLength != null ? `${img.focalLength}mm` : null,
      img.fnumber != null ? `f/${img.fnumber}` : null,
      img.exposureTime ? `${img.exposureTime}s` : null,
      img.iso != null ? `ISO ${img.iso}` : null,
    ].filter(Boolean);
    if (exp.length) lines.push(`Exposure: ${exp.join(', ')}`);
    if (img.capturedAt) lines.push(`Captured: ${img.capturedAt}`);
  }
  if (s.source) lines.push(`Raw file: ${s.source.color.isRaw ? 'yes' : 'no'}`);
  lines.push(`As-shot white balance: ${Math.round(s.base.wb.temp)} K, tint ${Math.round(s.base.wb.tint)}`);
  const p = s.committed;
  if (sel) {
    const m = sel.mask;
    lines.push(
      `Active mask ("the selection"): id ${m.id}, name "${m.name}", kind ${m.kind}.` +
        (withOverlay ? ' Image 1 is the current render; image 2 shows this selection tinted red.' : ''),
    );
  } else if (p.masks.length) {
    lines.push(`Masks present: ${p.masks.length} (see "masks" in the settings). No active selection.`);
  }
  if (p.spots.length) lines.push(`Spot removals present (not editable by you): ${p.spots.length}`);
  if (histogram) lines.push(histogram);
  lines.push('', 'Current settings:', JSON.stringify(compactParams(p)));
  return lines.join('\n');
}

/** [image, text] for the current photo; text only when no render is available. */
export async function captureContext(): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  const sel = activeSelection();
  let withOverlay = false;
  let histogram: string | null = null;
  try {
    const r = await renderJpeg();
    if (r) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.data } });
      histogram = histogramSummary(r.px, r.w, r.h);
      if (sel) {
        const tinted = await renderJpeg(sel.index, sel.mask.invert);
        if (tinted) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: tinted.data } });
          withOverlay = true;
        }
      }
    }
  } catch (e) {
    console.warn('AI context render failed', e);
  }
  blocks.push({ type: 'text', text: describe(sel, withOverlay, histogram) });
  return blocks;
}
