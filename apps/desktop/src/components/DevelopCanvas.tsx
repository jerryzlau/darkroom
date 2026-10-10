import { sourceToCrop, tempTintFromNeutral, type Geometry } from '@darkroom/core';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { computeHistogram, cropUvToSource, Engine, type DetailRequest, type Layout } from '../engine/Engine';
import { parseRegion, sampleCamera } from '../engine/source';
import { backend } from '../ipc/backend';
import { setRedraw, setEngine } from '../state/engineHub';
import { setThumbnailer, useDevelop } from '../state/develop';
import { useLibrary } from '../state/library';
import { toast } from '../state/toast';
import { CropOverlay } from './CropOverlay';
import { MaskOverlay } from './MaskOverlay';
import { SelectOverlay } from './SelectOverlay';
import { SpotOverlay } from './SpotOverlay';


export interface Histo {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  max: number;
}

export const useHistogram = create<{ h: Histo | null; set(h: Histo | null): void }>((set) => ({
  h: null,
  set: (h) => set({ h }),
}));

/** Shared view geometry for overlays: CSS px <-> source uv. */
export interface ViewMapper {
  layout: Layout;
  dpr: number;
  geo: Geometry;
  info: { width: number; height: number };
  toSource(x: number, y: number): [number, number];
  toScreen(u: number, v: number): [number, number];
  /** CSS px per full-res source px */
  pxScale: number;
}

function makeMapper(layout: Layout, dpr: number, geo: Geometry, info: { width: number; height: number }): ViewMapper {
  const g: Geometry = { ...geo, crop: layout.viewRect };
  const src = { w: info.width, h: info.height };
  return {
    layout,
    dpr,
    geo,
    info,
    pxScale: layout.scale / dpr,
    toSource(x, y) {
      const u = (x * dpr - layout.origin[0]) / (layout.cropPx[0] * layout.scale);
      const v = (y * dpr - layout.origin[1]) / (layout.cropPx[1] * layout.scale);
      return cropUvToSource(g, info, u, v);
    },
    toScreen(su, sv) {
      const [u, v] = sourceToCrop(g, src, su, sv);
      return [(layout.origin[0] + u * layout.cropPx[0] * layout.scale) / dpr, (layout.origin[1] + v * layout.cropPx[1] * layout.scale) / dpr];
    },
  };
}

export function DevelopCanvas({ readOnly = false }: { readOnly?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const frame = useRef(0);
  const [mapper, setMapper] = useState<ViewMapper | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const detailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailToken = useRef(0);
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedSource = useRef<unknown>(null);
  const pan = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  const source = useDevelop((s) => s.source);
  const loading = useDevelop((s) => s.loading);
  const tool = useDevelop((s) => s.tool);
  const view = useDevelop((s) => s.view);

  // ---- engine lifecycle ----
  useEffect(() => {
    // A fresh element per engine: dispose() loses the context for good, so an
    // effect re-run (Fast Refresh) must never reuse the old canvas.
    const wrap = wrapRef.current!;
    const canvas = document.createElement('canvas');
    wrap.prepend(canvas);
    let engine: Engine;
    try {
      engine = new Engine(canvas);
    } catch (e) {
      setGlError(String(e));
      backend().log('error', `engine init: ${e}`);
      canvas.remove();
      return;
    }
    engineRef.current = engine;
    setEngine(engine);
    backend().log('info', `engine ready (max texture ${engine.maxTextureSize})`);

    const draw = () => {
      frame.current = 0;
      const s = useDevelop.getState();
      const e = engineRef.current;
      if (!e || !s.source) return;
      e.sync(s.source, s.params, s.base);
      loadedSource.current = s.source;
      let lay: Layout | null = null;
      try {
        lay = e.render(s.view);
      } catch (err) {
        console.error(err);
        backend().log('error', `render: ${err}`);
        return;
      }
      if (lay) {
        const dpr = window.devicePixelRatio || 1;
        setMapper(makeMapper(lay, dpr, s.params.geometry, s.source.info));
      }
      scheduleHistogram();
      scheduleDetail();
    };
    const request = () => {
      if (!frame.current) frame.current = requestAnimationFrame(draw);
    };
    setRedraw(request);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = wrapRef.current!.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (w === canvas.width && h === canvas.height) return;
      // Setting the backing size clears the GL buffer. ResizeObserver runs after
      // this frame's rAF callbacks, so a deferred redraw would paint one black
      // frame first; draw synchronously instead.
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      if (frame.current) cancelAnimationFrame(frame.current);
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrapRef.current!);

    const scheduleHistogram = () => {
      if (histTimer.current) return;
      histTimer.current = setTimeout(() => {
        histTimer.current = null;
        const e2 = engineRef.current;
        const s = useDevelop.getState();
        if (!e2 || !s.source) return;
        e2.sync(s.source, s.params, s.base);
        const W = 320;
        const g = s.params.geometry;
        const fw = g.rotate % 2 ? s.source.info.height : s.source.info.width;
        const fh = g.rotate % 2 ? s.source.info.width : s.source.info.height;
        const ar = (g.crop.w * fw) / (g.crop.h * fh);
        const px = e2.renderSmall(W, Math.max(1, Math.round(W / Math.max(0.2, ar))), 'srgb', { before: s.view.before });
        if (px) useHistogram.getState().set(computeHistogram(px));
      }, 120);
    };

    const scheduleDetail = () => {
      if (detailTimer.current) clearTimeout(detailTimer.current);
      detailTimer.current = setTimeout(loadDetail, 140);
    };

    const loadDetail = async () => {
      const e2 = engineRef.current;
      const s = useDevelop.getState();
      if (!e2 || !s.source || !s.image) return;
      const want = e2.wantedDetail(s.params, s.view, canvas.width, canvas.height);
      if (!want) {
        if (e2.detailRegion) {
          e2.setDetail(null);
          lastDetail.current = null;
          request();
        }
        return;
      }
      const cur = e2.detailRegion;
      if (cur && covers(cur, want, e2)) return;
      const token = ++detailToken.current;
      const info = s.source.info;
      const photoId = s.image.photoId;
      try {
        const buf = await backend().getRegion(photoId, want.x * info.width, want.y * info.height, want.w * info.width, want.h * info.height, want.ow, want.oh);
        if (token !== detailToken.current || useDevelop.getState().source !== s.source) return;
        const r = parseRegion(buf);
        e2.setDetail({ ...want, ow: r.w, oh: r.h, data: r.data });
        lastDetail.current = want;
        request();
      } catch (err) {
        backend().log('warn', `detail region: ${err}`);
      }
    };

    const lastDetail = { current: null as DetailRequest | null };
    const covers = (cur: [number, number, number, number], want: DetailRequest, e2: Engine) => {
      const ld = lastDetail.current;
      if (!ld) return false;
      void e2;
      const eps = 1e-4;
      const inside =
        want.x >= cur[0] - eps && want.y >= cur[1] - eps && want.x + want.w <= cur[0] + cur[2] + eps && want.y + want.h <= cur[1] + cur[3] + eps;
      const res = ld.ow / ld.w >= (want.ow / want.w) * 0.95;
      return inside && res;
    };

    setThumbnailer(async (imageId, edited) => {
      const e2 = engineRef.current;
      const s = useDevelop.getState();
      if (!e2 || s.imageId !== imageId || !s.source) return;
      const b = backend();
      if (!edited) {
        await b.resetEditThumb(imageId);
        useLibrary.getState().patchImage(imageId, { thumbRev: 0 });
        return;
      }
      const g = s.params.geometry;
      const info = s.source.info;
      const fw = g.rotate % 2 ? info.height : info.width;
      const fh = g.rotate % 2 ? info.width : info.height;
      const ar = (g.crop.w * fw) / (g.crop.h * fh);
      const L = 640;
      const w = ar >= 1 ? L : Math.round(L * ar);
      const h = ar >= 1 ? Math.round(L / ar) : L;
      e2.sync(s.source, s.params, s.base);
      const px = e2.renderSmall(w, h, 'srgb', { before: false });
      request();
      if (!px) return;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(w, h);
      img.data.set(px);
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (!blob) return;
      const rev = await b.saveEditThumb(imageId, new Uint8Array(await blob.arrayBuffer()));
      useLibrary.getState().patchImage(imageId, { thumbRev: rev });
      useDevelop.setState((st) => ({ thumbVersion: st.thumbVersion + 1 }));
    });

    // Size the canvas (and draw if a source is already loaded) only once every
    // helper draw() reaches is initialized.
    resize();

    const onLost = (ev: Event) => {
      ev.preventDefault();
      toast('The graphics context was lost. Reopen the photo to continue.', 'error');
    };
    canvas.addEventListener('webglcontextlost', onLost);

    return () => {
      // our own dispose() releases the context; don't report that as a failure
      canvas.removeEventListener('webglcontextlost', onLost);
      ro.disconnect();
      if (frame.current) cancelAnimationFrame(frame.current);
      setRedraw(null);
      setThumbnailer(null);
      setEngine(null);
      engine.dispose();
      canvas.remove();
      engineRef.current = null;
      loadedSource.current = null;
    };
  }, []);

  // redraw when the source changes
  useEffect(() => {
    useDevelop.getState().setView({});
  }, [source]);

  // space bar = temporary hand tool
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ---- interactions ----
  const zoomAt = (clientX: number, clientY: number, zoom: number) => {
    const s = useDevelop.getState();
    const m = mapper;
    if (!m) return;
    const r = wrapRef.current!.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    const lay = m.layout;
    // crop uv under the cursor
    const u = (x * m.dpr - lay.origin[0]) / (lay.cropPx[0] * lay.scale);
    const v = (y * m.dpr - lay.origin[1]) / (lay.cropPx[1] * lay.scale);
    const cw = lay.canvas[0];
    const ch = lay.canvas[1];
    // choose center so that (u,v) stays under the cursor at the new zoom
    const cx = u - (x * m.dpr - cw / 2) / (lay.cropPx[0] * zoom);
    const cy = v - (y * m.dpr - ch / 2) / (lay.cropPx[1] * zoom);
    s.setView({ mode: 'zoom', zoom, center: [clamp01(cx), clamp01(cy)] });
  };

  const fitScale = () => {
    const m = mapper;
    if (!m) return 1;
    const s = useDevelop.getState();
    if (s.view.mode === 'fit') return m.layout.scale;
    const lay = m.layout;
    const pad = s.view.pad;
    return Math.min((lay.canvas[0] - 2 * pad) / lay.cropPx[0], (lay.canvas[1] - 2 * pad) / lay.cropPx[1]);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !mapper) return;
    const s = useDevelop.getState();
    const handTool = spaceDown || (s.tool === 'none' || readOnly);
    if (s.tool === 'wb' && !spaceDown && !readOnly) {
      const r = wrapRef.current!.getBoundingClientRect();
      const [su, sv] = mapper.toSource(e.clientX - r.left, e.clientY - r.top);
      if (su < 0 || sv < 0 || su > 1 || sv > 1 || !s.source) return;
      const cam = sampleCamera(s.source, su, sv, 3);
      const { temp, tint } = tempTintFromNeutral(s.source.color, cam);
      s.setAndCommit((p) => {
        p.wb = { mode: 'custom', temp, tint };
      }, 'White Balance');
      return;
    }
    if (!handTool) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, cx: s.view.center[0], cy: s.view.center[1], moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p || !mapper) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < 4) return;
    p.moved = true;
    const s = useDevelop.getState();
    if (s.view.mode !== 'zoom') return;
    const lay = mapper.layout;
    s.setView({
      center: [
        clamp01(p.cx - (dx * mapper.dpr) / (lay.cropPx[0] * lay.scale)),
        clamp01(p.cy - (dy * mapper.dpr) / (lay.cropPx[1] * lay.scale)),
      ],
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = pan.current;
    pan.current = null;
    if (!p || p.moved || spaceDown) return;
    const s = useDevelop.getState();
    if (s.view.cropMode) return;
    // click toggles fit <-> 100%
    if (s.view.mode === 'fit') zoomAt(e.clientX, e.clientY, Math.max(1, fitScale() * 1.01));
    else s.setView({ mode: 'fit' });
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = useDevelop.getState();
    if (!mapper || s.view.cropMode) return;
    if (e.ctrlKey || e.metaKey) {
      const cur = s.view.mode === 'fit' ? mapper.layout.scale : s.view.zoom;
      const next = Math.min(8, Math.max(fitScale(), cur * Math.exp(-e.deltaY * 0.01)));
      if (next <= fitScale() * 1.001) s.setView({ mode: 'fit' });
      else zoomAt(e.clientX, e.clientY, next);
    } else if (s.view.mode === 'zoom') {
      const lay = mapper.layout;
      s.setView({
        center: [
          clamp01(s.view.center[0] + (e.deltaX * mapper.dpr) / (lay.cropPx[0] * lay.scale)),
          clamp01(s.view.center[1] + (e.deltaY * mapper.dpr) / (lay.cropPx[1] * lay.scale)),
        ],
      });
    }
  };

  const cursor =
    spaceDown || (tool === 'none' && view.mode === 'zoom')
      ? pan.current
        ? 'grabbing'
        : 'grab'
      : tool === 'wb' || tool === 'select'
        ? 'crosshair'
        : tool === 'none'
          ? 'zoom-in'
          : 'default';

  return (
    <div
      className="develop-canvas"
      ref={wrapRef}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      {!readOnly && mapper && source && tool === 'crop' && !spaceDown && <CropOverlay mapper={mapper} />}
      {!readOnly && mapper && source && tool === 'masks' && !spaceDown && <MaskOverlay mapper={mapper} />}
      {!readOnly && mapper && source && tool === 'spots' && !spaceDown && <SpotOverlay mapper={mapper} />}
      {!readOnly && mapper && source && tool === 'select' && !spaceDown && <SelectOverlay mapper={mapper} />}
      {loading && <div className="canvas-status">Loading…</div>}
      {glError && (
        <div className="canvas-status error">
          The image renderer could not start: {glError}
        </div>
      )}
      {view.before && <div className="canvas-badge">Before</div>}
      {view.mode === 'zoom' && mapper && <div className="canvas-badge right">{Math.round(mapper.layout.scale * 100)}%</div>}
    </div>
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
