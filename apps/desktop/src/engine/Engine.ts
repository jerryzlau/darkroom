import {
  bakeCurveLUT,
  camToPro,
  CURVE_LUT_SIZE,
  frameDims,
  hsvToRgb,
  MAX_PATCHES,
  PRO_TO_SRGB,
  proToOutput,
  rotatedBounds,
  SRGB_TO_PRO,
  wbMultipliers,
  type EditParams,
  type Patch,
  type Geometry,
  type OutputSpace,
  type SourceColor,
} from '@darkroom/core';
import { createTexture, ensureTarget, Program, type Target } from './gl';
import { maskGeometryKey, rasterizeMask } from './masks';
import {
  BLUR_FRAG,
  FINAL_FRAG,
  INPUT_FRAG,
  LUMA_FRAG,
  MAIN_FRAG,
  MAX_MASKS,
  MAX_SPOTS,
  NEUTRAL_FRAG,
  NR_FRAG,
  PATCH_FRAG,
  SPOT_FRAG,
  VERT,
} from './shaders';
import type { LoadedSource } from './source';

export interface ViewState {
  /** 'fit' fits the crop to the canvas; 'zoom' uses `zoom` device px per full-res px. */
  mode: 'fit' | 'zoom';
  zoom: number;
  /** Center of the view in crop UV (zoom mode). */
  center: [number, number];
  cropMode: boolean;
  showClipping: boolean;
  before: boolean;
  overlayMask: number;
  overlayInvert: boolean;
  bg: [number, number, number];
  /** padding around the image in fit mode, device px */
  pad: number;
}

export const defaultView = (): ViewState => ({
  mode: 'fit',
  zoom: 1,
  center: [0.5, 0.5],
  cropMode: false,
  showClipping: false,
  before: false,
  overlayMask: -1,
  overlayInvert: false,
  bg: [0.11, 0.11, 0.115],
  pad: 32,
});

export interface Layout {
  /** device px of the view rect's top-left corner */
  origin: [number, number];
  /** device px per full-res px */
  scale: number;
  /** size of the view rect in full-res px */
  cropPx: [number, number];
  /** the rect shown (crop, or rotated bounds in crop mode), in rotated-frame normalized coords */
  viewRect: Geometry['crop'];
  canvas: [number, number];
}

export interface DetailRequest {
  /** Region in source UV */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Output pixel size */
  ow: number;
  oh: number;
}

export interface DetailRegion extends DetailRequest {
  data: Float32Array;
}

/** All textures for one rendered region of the source (whole preview, a zoomed detail, an export tile). */
class RegionPipe {
  /** internal format for intermediate targets (RGBA32F where filterable, RGBA16F for large detail regions) */
  constructor(public fmt: number) {}
  src: WebGLTexture | null = null;
  w = 0;
  h = 0;
  region: [number, number, number, number] = [0, 0, 1, 1];
  safe: [number, number, number, number] = [0, 0, 1, 1];
  linRaw: Target | null = null;
  lin: Target | null = null;
  den: Target | null = null;
  lumA: Target | null = null;
  small: Target | null = null;
  dev: Target | null = null;
  keys = { input: '', nr: '', small: '', main: '' };

  upload(gl: WebGL2RenderingContext, data: Float32Array, w: number, h: number, region: [number, number, number, number]) {
    const srcFmt = this.fmt === gl.RGBA32F ? gl.RGB32F : gl.RGB16F;
    if (this.src && this.w === w && this.h === h) {
      gl.bindTexture(gl.TEXTURE_2D, this.src);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.FLOAT, data);
    } else {
      if (this.src) gl.deleteTexture(this.src);
      this.src = createTexture(gl, w, h, srcFmt, gl.RGB, gl.FLOAT, data);
    }
    this.w = w;
    this.h = h;
    this.region = region;
    this.safe = [region[0], region[1], region[0] + region[2], region[1] + region[3]];
    this.keys = { input: '', nr: '', small: '', main: '' };
  }

  dispose(gl: WebGL2RenderingContext) {
    if (this.src) gl.deleteTexture(this.src);
    for (const t of [this.linRaw, this.lin, this.den, this.lumA, this.small, this.dev]) {
      if (t) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
    }
    this.src = null;
    this.linRaw = this.lin = this.den = this.lumA = this.small = this.dev = null;
  }
}

const MASK_LONG = 2048;
/** Uploaded patch textures kept per engine (unreferenced ones beyond this are evicted). */
const MAX_PATCH_TEX = 24;

/** A patch ready to composite: its texture and the mask layer that gates it. */
interface ResolvedPatch {
  patch: Patch;
  tex: WebGLTexture;
  /** mask layer, or -1 for the soft-box fallback over `patch.area` */
  layer: number;
  invert: boolean;
}

export class Engine {
  readonly gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private pInput: Program;
  private pNr: Program;
  private pLuma: Program;
  private pBlur: Program;
  private pMain: Program;
  private pFinal: Program;
  private pSpot: Program;
  private pPatch: Program;
  private pNeutral: Program;

  source: LoadedSource | null = null;
  private preview: RegionPipe;
  private detail: RegionPipe | null = null;
  private tilePipe: RegionPipe;
  /** RGBA32F for precision-critical targets when float textures are filterable */
  private hiFmt: number;

  private ctxDown: Target | null = null;
  private ctxTmp: Target | null = null;
  private ctxMid: Target | null = null;
  private ctxLarge: Target | null = null;
  private ctxKey = '';

  private maskTex: WebGLTexture;
  private maskW = 1;
  private maskH = 1;
  private maskKeys: string[] = [];
  private maskCanvas: HTMLCanvasElement | OffscreenCanvas;
  private maskCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private scratch: { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D };

  private curveTex: WebGLTexture;
  private curveKey = '';
  private curveOn = false;

  private histTarget: Target | null = null;
  private outTarget: Target | null = null;
  private neutralTarget: Target | null = null;

  /** Generative-fill PNGs by sha256, uploaded as RGBA8 (sRGB-encoded, top-down). Insertion-ordered. */
  private patchTex = new Map<string, WebGLTexture>();

  params: EditParams | null = null;
  beforeParams: EditParams | null = null;
  readonly maxTextureSize: number;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    if (gl.isContextLost()) throw new Error('the WebGL context is lost');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float is not available');
    const floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.hiFmt = floatLinear ? gl.RGBA32F : gl.RGBA16F;
    this.preview = new RegionPipe(this.hiFmt);
    this.tilePipe = new RegionPipe(this.hiFmt);
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.vao = gl.createVertexArray()!;
    this.pInput = new Program(gl, VERT, INPUT_FRAG, 'input');
    this.pNr = new Program(gl, VERT, NR_FRAG, 'nr');
    this.pLuma = new Program(gl, VERT, LUMA_FRAG, 'luma');
    this.pBlur = new Program(gl, VERT, BLUR_FRAG, 'blur');
    this.pMain = new Program(gl, VERT, MAIN_FRAG, 'main');
    this.pFinal = new Program(gl, VERT, FINAL_FRAG, 'final');
    this.pSpot = new Program(gl, VERT, SPOT_FRAG, 'spot');
    this.pPatch = new Program(gl, VERT, PATCH_FRAG, 'patch');
    this.pNeutral = new Program(gl, VERT, NEUTRAL_FRAG, 'neutral');

    this.maskTex = gl.createTexture()!;
    this.allocMasks(1, 1);
    this.curveTex = createTexture(gl, CURVE_LUT_SIZE, 1, gl.RGBA16F, gl.RGBA, gl.FLOAT, new Float32Array(CURVE_LUT_SIZE * 4));

    const mk = (w: number, h: number) => {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    this.maskCanvas = mk(1, 1);
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D;
    const sc = mk(1, 1);
    this.scratch = { canvas: sc, ctx: sc.getContext('2d') as CanvasRenderingContext2D };
  }

  static capabilities(): { ok: boolean; reason?: string } {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false, reason: 'WebGL2 not available' };
      if (!gl.getExtension('EXT_color_buffer_float')) return { ok: false, reason: 'float render targets not available' };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  setSource(src: LoadedSource) {
    const gl = this.gl;
    this.source = src;
    const { previewWidth: w, previewHeight: h } = src.info;
    this.preview.upload(gl, src.data, w, h, [0, 0, 1, 1]);
    this.clearDetail();
    this.ctxKey = '';
    // masks are rasterized at up to MASK_LONG px on the long edge (or full resolution if smaller)
    const maskLong = Math.min(MASK_LONG, Math.max(src.info.width, src.info.height));
    const s = maskLong / Math.max(w, h);
    this.allocMasks(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  }

  /** Make sure the engine shows `src` with `p` (cheap when already in sync). */
  sync(src: LoadedSource, p: EditParams, before?: EditParams) {
    if (this.source !== src) this.setSource(src);
    this.setParams(p, before);
  }

  setParams(p: EditParams, before?: EditParams) {
    this.params = p;
    if (before) this.beforeParams = before;
  }

  setDetail(d: DetailRegion | null) {
    if (!d) return this.clearDetail();
    if (!this.detail) this.detail = new RegionPipe(this.gl.RGBA16F);
    this.detail.upload(this.gl, d.data, d.ow, d.oh, [d.x, d.y, d.w, d.h]);
    // keep a margin away from the region's inner edges where blurs see the border
    const mx = (d.w * 24) / d.ow;
    const my = (d.h * 24) / d.oh;
    this.detail.safe = [
      d.x <= 0 ? 0 : d.x + mx,
      d.y <= 0 ? 0 : d.y + my,
      d.x + d.w >= 1 ? 1 : d.x + d.w - mx,
      d.y + d.h >= 1 ? 1 : d.y + d.h - my,
    ];
  }

  clearDetail() {
    if (this.detail) this.detail.dispose(this.gl);
    this.detail = null;
  }

  get detailRegion(): [number, number, number, number] | null {
    return this.detail ? this.detail.region : null;
  }

  /** Upload (or replace) the decoded PNG for a patch asset. */
  setPatchAsset(hash: string, img: ImageBitmap | ImageData | HTMLCanvasElement): void {
    const gl = this.gl;
    const old = this.patchTex.get(hash);
    if (old) {
      gl.deleteTexture(old);
      this.patchTex.delete(hash);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.patchTex.set(hash, tex);
    if (this.patchTex.size > MAX_PATCH_TEX) {
      const used = new Set((this.params?.patches ?? []).map((q) => q.asset));
      used.add(hash);
      for (const [h, t] of this.patchTex) {
        if (this.patchTex.size <= MAX_PATCH_TEX) break;
        if (used.has(h)) continue;
        gl.deleteTexture(t);
        this.patchTex.delete(h);
      }
    }
  }

  hasPatchAsset(hash: string): boolean {
    return this.patchTex.has(hash);
  }

  private allocMasks(w: number, h: number) {
    const gl = this.gl;
    this.maskW = w;
    this.maskH = h;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, w, h, MAX_MASKS, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.maskKeys = [];
  }

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  private color(): SourceColor {
    return this.source!.color;
  }

  /** Patches that will actually be composited, in order (enabled, visible, with an uploaded texture). */
  private resolvePatches(p: EditParams): ResolvedPatch[] {
    const out: ResolvedPatch[] = [];
    for (const patch of p.patches.slice(0, MAX_PATCHES)) {
      if (!patch.enabled || !(patch.opacity > 0)) continue;
      const tex = this.patchTex.get(patch.asset);
      if (!tex) continue;
      // the mask's `enabled` flag is ignored on purpose: it gates the mask's adjustments, not the fill
      const mi = patch.maskId ? p.masks.findIndex((m) => m.id === patch.maskId) : -1;
      const layer = mi >= 0 && mi < MAX_MASKS ? mi : -1;
      out.push({ patch, tex, layer, invert: layer >= 0 ? p.masks[mi].invert : false });
    }
    return out;
  }

  private inputKey(p: EditParams, resolved: ResolvedPatch[], masksKey: string) {
    const anyLayer = resolved.some((r) => r.layer >= 0);
    return JSON.stringify([
      p.wb.mode,
      p.wb.temp,
      p.wb.tint,
      p.lens.vignette,
      p.spots,
      resolved.map((r) => [r.patch.asset, r.patch.rect, r.patch.area, r.layer, r.invert, r.patch.feather, r.patch.opacity, r.patch.ev]),
      anyLayer ? masksKey : '',
    ]);
  }

  private updateMasks(p: EditParams): string {
    const gl = this.gl;
    const masks = p.masks.slice(0, MAX_MASKS);
    const w = this.maskW;
    const h = this.maskH;
    if (this.maskCanvas.width !== w || this.maskCanvas.height !== h) {
      this.maskCanvas.width = w;
      this.maskCanvas.height = h;
      this.scratch.canvas.width = w;
      this.scratch.canvas.height = h;
      this.maskKeys = [];
    }
    masks.forEach((m, i) => {
      const key = maskGeometryKey(m);
      if (this.maskKeys[i] === key) return;
      rasterizeMask(this.maskCtx, m, w, h, this.scratch);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, w, h, 1, gl.RED, gl.UNSIGNED_BYTE, this.maskCanvas as TexImageSource);
      this.maskKeys[i] = key;
    });
    return this.maskKeys.slice(0, masks.length).join('|');
  }

  private updateCurve(p: EditParams): string {
    const key = JSON.stringify(p.toneCurve);
    if (key !== this.curveKey) {
      const lut = bakeCurveLUT(p.toneCurve);
      this.curveOn = lut !== null;
      if (lut) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CURVE_LUT_SIZE, 1, gl.RGBA, gl.FLOAT, lut);
      }
      this.curveKey = key;
    }
    return key;
  }

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  private draw(target: Target | null, w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private blur(src: Target, tmp: Target, dst: Target, sigma: number) {
    const p = this.pBlur;
    p.use();
    p.tex('uIn', src.tex);
    p.f('uDir', 1 / src.w, 0);
    p.f('uSigma', Math.max(0.3, sigma));
    this.draw(tmp, tmp.w, tmp.h);
    p.use();
    p.tex('uIn', tmp.tex);
    p.f('uDir', 0, 1 / tmp.h);
    p.f('uSigma', Math.max(0.3, sigma));
    this.draw(dst, dst.w, dst.h);
  }

  /** Full-res px per region texel scale. */
  private regionScale(pipe: RegionPipe) {
    return pipe.w / (pipe.region[2] * this.source!.info.width);
  }

  /**
   * INPUT (WB, camera -> ProPhoto, lens vignetting), then SPOT when there are
   * spots, then one PATCH per resolved patch, ping-ponging between linRaw and
   * lin so the last stage lands in `pipe.lin`. Needs `updateMasks` first.
   */
  private runInput(pipe: RegionPipe, p: EditParams, masksKey: string) {
    const gl = this.gl;
    const resolved = this.resolvePatches(p);
    const key = this.inputKey(p, resolved, masksKey);
    if (pipe.keys.input === key && pipe.lin) return false;
    const spots = p.spots.slice(0, MAX_SPOTS);
    const n = 1 + (spots.length > 0 ? 1 : 0) + resolved.length;
    pipe.lin = ensureTarget(gl, pipe.lin, pipe.w, pipe.h, pipe.fmt);
    if (n >= 2) pipe.linRaw = ensureTarget(gl, pipe.linRaw, pipe.w, pipe.h, pipe.fmt);
    const lin = pipe.lin;
    const raw = pipe.linRaw;
    // with an odd stage count the first stage writes lin, so the last one does too
    let dst: Target = n % 2 === 1 ? lin : raw!;
    let prev: Target = dst;
    const advance = () => {
      prev = dst;
      dst = dst === lin ? raw! : lin;
    };

    const c = this.color();
    const mul = wbMultipliers(c, p.wb);
    const clip = c.isRaw ? Math.min(mul[0], mul[1], mul[2]) : 1e9;
    const info = this.source!.info;
    const long = Math.max(info.width, info.height);
    const pr = this.pInput;
    pr.use();
    pr.tex('uSrc', pipe.src);
    pr.f('uWB', mul[0], mul[1], mul[2]);
    pr.f('uClip', clip);
    pr.m3('uCamToPro', camToPro(c));
    pr.f('uRegion', ...pipe.region);
    pr.f('uAspect', info.width / long, info.height / long);
    pr.f('uLensVig', p.lens.vignette / 100);
    this.draw(dst, pipe.w, pipe.h);
    advance();

    if (spots.length > 0) {
      const ps = this.pSpot;
      ps.use();
      ps.tex('uIn', prev.tex);
      ps.f('uRegion', ...pipe.region);
      // Non-preview pipes fall back to the preview's lin for spot sources outside
      // their region. That texture is post-patch (an accepted limitation).
      const hasFallback = pipe !== this.preview && !!this.preview.lin;
      ps.tex('uFallback', hasFallback ? this.preview.lin!.tex : prev.tex);
      ps.b('uHasFallback', hasFallback);
      ps.f('uAspect', info.width / long, info.height / long);
      ps.i('uCount', spots.length);
      const A = new Float32Array(MAX_SPOTS * 4);
      const B = new Float32Array(MAX_SPOTS * 4);
      spots.forEach((sp, i) => {
        A.set([sp.x, sp.y, sp.sx, sp.sy], i * 4);
        B.set([sp.r, sp.feather, sp.opacity, sp.mode === 'clone' ? 1 : 0], i * 4);
      });
      ps.v4('uSpotA', A);
      ps.v4('uSpotB', B);
      this.draw(dst, pipe.w, pipe.h);
      advance();
    }

    for (const r of resolved) {
      const pp = this.pPatch;
      pp.use();
      pp.tex('uIn', prev.tex);
      pp.tex('uPatch', r.tex);
      pp.tex('uMasks', this.maskTex, gl.TEXTURE_2D_ARRAY);
      pp.f('uRegion', ...pipe.region);
      pp.f('uRect', ...r.patch.rect);
      pp.f('uArea', ...r.patch.area);
      pp.f('uAspect', info.width / long, info.height / long);
      pp.f('uFeather', r.patch.feather);
      pp.i('uLayer', r.layer);
      pp.b('uInvert', r.invert);
      pp.f('uOpacity', r.patch.opacity);
      pp.f('uEv', r.patch.ev);
      pp.m3('uSrgbToPro', SRGB_TO_PRO);
      this.draw(dst, pipe.w, pipe.h);
      advance();
    }

    pipe.keys.input = key;
    pipe.keys.nr = '';
    return true;
  }

  private runNr(pipe: RegionPipe, p: EditParams): Target {
    const d = p.detail;
    const on = d.nrLuma > 0 || d.nrColor > 0;
    if (!on) {
      pipe.keys.nr = pipe.keys.input + '|off';
      return pipe.lin!;
    }
    const key = pipe.keys.input + JSON.stringify([d.nrLuma, d.nrLumaDetail, d.nrColor, d.nrColorDetail]);
    if (pipe.keys.nr === key && pipe.den) return pipe.den;
    const gl = this.gl;
    pipe.den = ensureTarget(gl, pipe.den, pipe.w, pipe.h, pipe.fmt);
    const pr = this.pNr;
    pr.use();
    pr.tex('uIn', pipe.lin!.tex);
    // Noise is a full-resolution phenomenon: scale the filter footprint to the region's scale.
    const s = Math.min(1, Math.max(0.35, this.regionScale(pipe)));
    pr.f('uTexel', s / pipe.w, s / pipe.h);
    pr.f('uLuma', d.nrLuma / 100);
    pr.f('uLumaDetail', d.nrLumaDetail / 100);
    pr.f('uColor', d.nrColor / 100);
    pr.f('uColorDetail', d.nrColorDetail / 100);
    this.draw(pipe.den, pipe.w, pipe.h);
    pipe.keys.nr = key;
    return pipe.den;
  }

  private needsTexture(p: EditParams) {
    return p.texture !== 0 || p.masks.some((m) => m.enabled && m.adj.texture !== 0);
  }

  private runSmall(pipe: RegionPipe, p: EditParams, den: Target): Target | null {
    if (!this.needsTexture(p)) return null;
    const info = this.source!.info;
    const sigma = 0.0011 * Math.max(info.width, info.height) * this.regionScale(pipe);
    const key = pipe.keys.nr + '|' + sigma.toFixed(3);
    if (pipe.keys.small === key && pipe.small) return pipe.small;
    const gl = this.gl;
    pipe.lumA = ensureTarget(gl, pipe.lumA, pipe.w, pipe.h, pipe.fmt);
    pipe.small = ensureTarget(gl, pipe.small, pipe.w, pipe.h, pipe.fmt);
    const tmp = ensureTarget(gl, pipe.dev, pipe.w, pipe.h, pipe.fmt);
    pipe.dev = tmp;
    pipe.keys.main = '';
    const pr = this.pLuma;
    pr.use();
    pr.tex('uIn', den.tex);
    pr.f('uTexel', 1 / pipe.w, 1 / pipe.h);
    pr.f('uBox', 0);
    this.draw(pipe.lumA, pipe.w, pipe.h);
    this.blur(pipe.lumA, tmp, pipe.small, sigma);
    pipe.keys.small = key;
    return pipe.small;
  }

  /** Global context (blurred luminance and dark channel) from the preview. */
  private runContext(p: EditParams) {
    const key = this.preview.keys.input;
    if (this.ctxKey === key && this.ctxLarge) return;
    const gl = this.gl;
    const pv = this.preview;
    const long = Math.max(pv.w, pv.h);
    const s = Math.min(1, 640 / long);
    const w = Math.max(1, Math.round(pv.w * s));
    const h = Math.max(1, Math.round(pv.h * s));
    this.ctxDown = ensureTarget(gl, this.ctxDown, w, h, this.hiFmt);
    this.ctxTmp = ensureTarget(gl, this.ctxTmp, w, h, this.hiFmt);
    this.ctxMid = ensureTarget(gl, this.ctxMid, w, h, this.hiFmt);
    this.ctxLarge = ensureTarget(gl, this.ctxLarge, w, h, this.hiFmt);
    const pr = this.pLuma;
    pr.use();
    pr.tex('uIn', pv.lin!.tex);
    pr.f('uTexel', 1 / w, 1 / h);
    pr.f('uBox', 1);
    this.draw(this.ctxDown, w, h);
    const lw = Math.max(w, h);
    this.blur(this.ctxDown, this.ctxTmp, this.ctxMid, 0.007 * lw);
    this.blur(this.ctxDown, this.ctxTmp, this.ctxLarge, 0.025 * lw);
    this.ctxKey = key;
    void p;
  }

  private mainUniforms(p: EditParams) {
    const pr = this.pMain;
    const c = this.color();
    pr.b('uIsRaw', c.isRaw);
    pr.f('uExposure', p.exposure + (c.isRaw ? 0.5 : 0));
    pr.f('uContrast', p.contrast / 100);
    pr.f('uHighlights', p.highlights / 100);
    pr.f('uShadows', p.shadows / 100);
    pr.f('uWhites', p.whites / 100);
    pr.f('uBlacks', p.blacks / 100);
    pr.f('uTexture', p.texture / 100);
    pr.f('uClarity', p.clarity / 100);
    pr.f('uDehaze', p.dehaze / 100);
    pr.f('uVibrance', p.vibrance / 100);
    pr.f('uSaturation', p.saturation / 100);
    pr.f('uAirlight', this.source!.airlight);
    pr.b('uCurveOn', this.curveOn);
    pr.b('uBW', p.treatment === 'bw');
    const hslOn = [...p.hsl.hue, ...p.hsl.sat, ...p.hsl.lum].some((v) => v !== 0);
    pr.b('uHslOn', hslOn);
    pr.fv('uHslHue', p.hsl.hue.map((v) => v / 100));
    pr.fv('uHslSat', p.hsl.sat.map((v) => v / 100));
    pr.fv('uHslLum', p.hsl.lum.map((v) => v / 100));
    pr.fv('uBwMix', p.bwMix.map((v) => v / 100));
    const gr = p.grading;
    const wheel = (w: { h: number; s: number; l: number }) => {
      const rgb = hsvToRgb(w.h, 1, 1);
      const y = 0.2880402 * rgb[0] + 0.7118741 * rgb[1] + 0.0000857 * rgb[2];
      const k = (w.s / 100) * 0.22;
      return [(rgb[0] - y) * k, (rgb[1] - y) * k, (rgb[2] - y) * k, w.l / 100];
    };
    const gradeOn = [gr.shadows, gr.midtones, gr.highlights, gr.global].some((w) => w.s !== 0 || w.l !== 0);
    pr.b('uGradeOn', gradeOn);
    pr.f('uGradeS', ...wheel(gr.shadows));
    pr.f('uGradeM', ...wheel(gr.midtones));
    pr.f('uGradeH', ...wheel(gr.highlights));
    pr.f('uGradeG', ...wheel(gr.global));
    pr.f('uGradeParams', 4 - 2.8 * (gr.blending / 100), gr.balance / 100);

    const masks = p.masks.slice(0, MAX_MASKS);
    pr.i('uMaskCount', masks.length);
    const info = new Float32Array(MAX_MASKS * 4);
    const range = new Float32Array(MAX_MASKS * 4);
    const range2 = new Float32Array(MAX_MASKS * 4);
    const A = new Float32Array(MAX_MASKS * 4);
    const B = new Float32Array(MAX_MASKS * 4);
    const C = new Float32Array(MAX_MASKS * 4);
    masks.forEach((m, i) => {
      const o = i * 4;
      info.set([m.amount / 100, m.invert ? 1 : 0, m.range.mode === 'luminance' ? 1 : m.range.mode === 'color' ? 2 : 0, m.enabled ? 1 : 0], o);
      range.set([m.range.lumMin / 100, m.range.lumMax / 100, Math.max(0.001, m.range.lumFeather / 100), 0.05 + (m.range.amount / 100) * 0.6], o);
      range2.set([m.range.hue, m.range.sat, 0, 0], o);
      const a = m.adj;
      A.set([a.exposure, a.contrast / 100, a.highlights / 100, a.shadows / 100], o);
      B.set([a.whites / 100, a.blacks / 100, a.temp / 100, a.tint / 100], o);
      C.set([a.saturation / 100, a.clarity / 100, a.dehaze / 100, a.texture / 100], o);
    });
    pr.v4('uMaskInfo', info);
    pr.v4('uMaskRange', range);
    pr.v4('uMaskRange2', range2);
    pr.v4('uMaskA', A);
    pr.v4('uMaskB', B);
    pr.v4('uMaskC', C);
  }

  private mainKey(p: EditParams, masksKey: string, curveKey: string) {
    const { geometry: _g, effects: _e, detail, lens, wb: _wb, ...rest } = p;
    void _g;
    void _e;
    void _wb;
    return JSON.stringify([rest, detail.nrLuma, detail.nrColor, lens.vignette, masksKey, curveKey]);
  }

  /** Bring a region's developed texture up to date. */
  private develop(pipe: RegionPipe, p: EditParams) {
    if (!this.source || !pipe.src) return;
    // masks first: PATCH stages in runInput sample them
    const masksKey = this.updateMasks(p);
    // the global context always comes from the preview, whichever region we develop
    this.runInput(this.preview, p, masksKey);
    this.runContext(p);
    if (pipe !== this.preview) this.runInput(pipe, p, masksKey);
    const den = this.runNr(pipe, p);
    const small = this.runSmall(pipe, p, den);
    const curveKey = this.updateCurve(p);
    const key = pipe.keys.nr + '|' + pipe.keys.small + '|' + this.ctxKey + '|' + this.mainKey(p, masksKey, curveKey);
    if (pipe.keys.main === key && pipe.dev) return;
    const gl = this.gl;
    pipe.dev = ensureTarget(gl, pipe.dev, pipe.w, pipe.h, pipe.fmt);
    const pr = this.pMain;
    pr.use();
    pr.tex('uLin', den.tex);
    pr.tex('uSmall', small ? small.tex : den.tex);
    pr.tex('uCtxMid', this.ctxMid!.tex);
    pr.tex('uCtxLarge', this.ctxLarge!.tex);
    pr.tex('uMasks', this.maskTex, gl.TEXTURE_2D_ARRAY);
    pr.tex('uCurve', this.curveTex);
    pr.f('uRegion', ...pipe.region);
    this.mainUniforms(p);
    this.draw(pipe.dev, pipe.w, pipe.h);
    pipe.keys.main = key;
  }

  // -------------------------------------------------------------------------
  // Layout & output
  // -------------------------------------------------------------------------

  layout(p: EditParams, view: ViewState, cw: number, ch: number): Layout {
    const info = this.source!.info;
    const src = { w: info.width, h: info.height };
    const f = frameDims(src, p.geometry.rotate);
    const viewRect = view.cropMode ? rotatedBounds(p.geometry, src) : p.geometry.crop;
    const cropPx: [number, number] = [viewRect.w * f.w, viewRect.h * f.h];
    let scale: number;
    let origin: [number, number];
    if (view.mode === 'fit' || view.cropMode) {
      const pad = view.cropMode ? view.pad * 2 : view.pad;
      scale = Math.min((cw - 2 * pad) / cropPx[0], (ch - 2 * pad) / cropPx[1]);
      origin = [(cw - cropPx[0] * scale) / 2, (ch - cropPx[1] * scale) / 2];
    } else {
      scale = view.zoom;
      const [cx, cy] = view.center;
      origin = [cw / 2 - cx * cropPx[0] * scale, ch / 2 - cy * cropPx[1] * scale];
      // keep the image covering the view when it is larger than the view
      const iw = cropPx[0] * scale;
      const ih = cropPx[1] * scale;
      origin[0] = iw <= cw ? (cw - iw) / 2 : Math.min(0, Math.max(cw - iw, origin[0]));
      origin[1] = ih <= ch ? (ch - ih) / 2 : Math.min(0, Math.max(ch - ih, origin[1]));
    }
    return { origin, scale, cropPx, viewRect, canvas: [cw, ch] };
  }

  /** Which region (if any) should be loaded at higher resolution for this view. */
  wantedDetail(p: EditParams, view: ViewState, cw: number, ch: number): DetailRequest | null {
    if (!this.source) return null;
    const info = this.source.info;
    const lay = this.layout(p, view, cw, ch);
    const previewScale = info.previewWidth / info.width;
    if (lay.scale <= previewScale * 1.1) return null;
    // visible crop-uv rect
    const u0 = Math.max(0, -lay.origin[0] / (lay.cropPx[0] * lay.scale));
    const v0 = Math.max(0, -lay.origin[1] / (lay.cropPx[1] * lay.scale));
    const u1 = Math.min(1, (cw - lay.origin[0]) / (lay.cropPx[0] * lay.scale));
    const v1 = Math.min(1, (ch - lay.origin[1]) / (lay.cropPx[1] * lay.scale));
    const g = { ...p.geometry, crop: lay.viewRect };
    const pts: [number, number][] = [];
    for (const u of [u0, (u0 + u1) / 2, u1]) for (const v of [v0, (v0 + v1) / 2, v1]) pts.push(cropUvToSource(g, info, u, v));
    let x0 = Math.min(...pts.map((q) => q[0]));
    let y0 = Math.min(...pts.map((q) => q[1]));
    let x1 = Math.max(...pts.map((q) => q[0]));
    let y1 = Math.max(...pts.map((q) => q[1]));
    const padU = 0.03 * (x1 - x0) + 32 / info.width;
    const padV = 0.03 * (y1 - y0) + 32 / info.height;
    [x0, y0, x1, y1] = expandForSpots([x0 - padU, y0 - padV, x1 + padU, y1 + padV], p, info);
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(1, x1);
    y1 = Math.min(1, y1);
    const s = Math.min(1, lay.scale);
    let ow = Math.round((x1 - x0) * info.width * s);
    let oh = Math.round((y1 - y0) * info.height * s);
    const cap = Math.min(4096, this.maxTextureSize);
    const k = Math.min(1, cap / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * k));
    oh = Math.max(1, Math.round(oh * k));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, ow, oh };
  }

  private finalUniforms(
    p: EditParams,
    view: ViewState,
    lay: Layout,
    pipe: RegionPipe,
    opts: { flipY: boolean; targetH: number; space: OutputSpace; encode: boolean; dither: boolean; overlays: boolean; detail: RegionPipe | null },
  ) {
    const gl = this.gl;
    const pr = this.pFinal;
    const info = this.source!.info;
    const f = frameDims({ w: info.width, h: info.height }, p.geometry.rotate);
    pr.tex('uDev', pipe.dev!.tex);
    pr.f('uDevRegion', ...pipe.region);
    pr.f('uDevSize', pipe.w, pipe.h);
    const det = opts.detail && opts.detail.dev ? opts.detail : null;
    pr.b('uHasDetail', !!det);
    pr.tex('uDetail', det ? det.dev!.tex : pipe.dev!.tex);
    pr.f('uDetailRegion', ...(det ? det.region : pipe.region));
    pr.f('uDetailSafe', ...(det ? det.safe : [0, 0, 0, 0]));
    pr.f('uDetailSize', det ? det.w : pipe.w, det ? det.h : pipe.h);
    pr.tex('uMasks', this.maskTex, gl.TEXTURE_2D_ARRAY);
    pr.f('uFrame', f.w, f.h);
    pr.f('uCrop', lay.viewRect.x, lay.viewRect.y, lay.viewRect.w, lay.viewRect.h);
    pr.f('uAngle', (p.geometry.angle * Math.PI) / 180);
    pr.i('uRot', p.geometry.rotate);
    pr.bv2('uFlip', p.geometry.flipH, p.geometry.flipV);
    pr.f('uViewOrigin', lay.origin[0], lay.origin[1]);
    pr.f('uViewScale', lay.scale);
    pr.f('uCropPx', lay.cropPx[0], lay.cropPx[1]);
    pr.f('uTargetH', opts.targetH);
    pr.b('uFlipY', opts.flipY);
    pr.f('uDistortion', -p.lens.distortion / 100 * 0.18);
    pr.f('uCaR', p.lens.caRed / 100 * 0.004);
    pr.f('uCaB', p.lens.caBlue / 100 * 0.004);
    // sharpening radius is defined in full-res px; convert to the texels being sampled
    const texelPerFull = (det ? det.w / (det.region[2] * info.width) : pipe.w / (pipe.region[2] * info.width));
    const sharpAmt = view.before ? 0 : p.detail.sharpAmount / 100;
    pr.f('uSharp', sharpAmt * Math.min(1, texelPerFull * 1.2), Math.max(0.5, p.detail.sharpRadius * texelPerFull), p.detail.sharpDetail / 100, p.detail.sharpMasking / 100);
    const e = p.effects;
    const vig = view.before ? 0 : e.vignetteAmount / 100;
    pr.f('uVig', vig, e.vignetteMidpoint / 100, e.vignetteRoundness / 100, e.vignetteFeather / 100);
    pr.f('uGrain', view.before ? 0 : e.grainAmount / 100, 0.00035 + (e.grainSize / 100) * 0.0028, e.grainRoughness / 100);
    pr.m3('uProToOut', proToOutput(opts.space));
    pr.i('uOutTRC', opts.space === 'prophoto' ? 1 : 0);
    pr.b('uEncode', opts.encode);
    pr.b('uShowClip', opts.overlays && view.showClipping);
    pr.i('uOverlayMask', opts.overlays ? view.overlayMask : -1);
    pr.b('uOverlayInvert', view.overlayInvert);
    pr.f('uBg', ...view.bg);
    pr.b('uDither', opts.dither);
  }

  private activeParams(view: ViewState): EditParams {
    const p = this.params!;
    if (view.before && this.beforeParams) {
      return { ...this.beforeParams, geometry: p.geometry, lens: p.lens };
    }
    return p;
  }

  /** Render to the canvas. Returns the layout used (for overlays and hit testing). */
  render(view: ViewState): Layout | null {
    if (!this.source || !this.params) return null;
    const p = this.activeParams(view);
    this.develop(this.preview, p);
    if (this.detail) this.develop(this.detail, p);
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const lay = this.layout(p, view, cw, ch);
    this.pFinal.use();
    this.finalUniforms(p, view, lay, this.preview, {
      flipY: true,
      targetH: ch,
      space: 'srgb',
      encode: true,
      dither: true,
      overlays: true,
      detail: this.detail,
    });
    this.draw(null, cw, ch);
    return lay;
  }

  /**
   * Render the full crop (from the preview) at `w` x `h` into RGBA8 pixels,
   * rows top-down. Used for histograms and edited thumbnails.
   */
  renderSmall(
    w: number,
    h: number,
    space: OutputSpace = 'srgb',
    view?: Partial<ViewState>,
    opts?: { overlayMask?: number; overlayInvert?: boolean },
  ): Uint8Array | null {
    if (!this.source || !this.params) return null;
    const gl = this.gl;
    const overlayMask = opts?.overlayMask ?? -1;
    const v: ViewState = {
      ...defaultView(),
      ...view,
      mode: 'fit',
      pad: 0,
      cropMode: false,
      showClipping: false,
      overlayMask,
      overlayInvert: opts?.overlayInvert ?? false,
    };
    const p = this.activeParams(v);
    this.develop(this.preview, p);
    const t = (this.histTarget = ensureTarget(gl, this.histTarget, w, h, gl.RGBA8));
    const lay = this.layout(p, v, w, h);
    this.pFinal.use();
    this.finalUniforms(p, v, lay, this.preview, { flipY: false, targetH: h, space, encode: true, dither: false, overlays: overlayMask >= 0, detail: null });
    this.draw(t, w, h);
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /**
   * Render a source-UV rect of the pre-develop image (WB, spots, earlier
   * patches; from the preview) as display sRGB RGBA8 at `w` x `h`, rows
   * top-down: the "neutral render" a generative model sees. `ev` brightens by
   * that many stops before the sRGB clamp; `overlayMask` tints a mask layer red.
   */
  renderNeutralRect(
    p: EditParams,
    rect: [number, number, number, number],
    w: number,
    h: number,
    opts: { ev: number; overlayMask?: number; overlayInvert?: boolean },
  ): Uint8Array | null {
    if (!this.source || !this.preview.src) return null;
    const gl = this.gl;
    this.params = p;
    const masksKey = this.updateMasks(p);
    this.runInput(this.preview, p, masksKey);
    const t = (this.neutralTarget = ensureTarget(gl, this.neutralTarget, w, h, gl.RGBA8));
    const pr = this.pNeutral;
    pr.use();
    pr.tex('uLin', this.preview.lin!.tex);
    pr.tex('uMasks', this.maskTex, gl.TEXTURE_2D_ARRAY);
    pr.f('uRegion', ...this.preview.region);
    pr.f('uRect', ...rect);
    pr.f('uEv', opts.ev);
    pr.m3('uProToSrgb', PRO_TO_SRGB);
    pr.i('uOverlayMask', opts.overlayMask ?? -1);
    pr.b('uOverlayInvert', opts.overlayInvert ?? false);
    this.draw(t, w, h);
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /**
   * Render one export tile. `region` is a full-resolution source region (any
   * scale) covering the tile's footprint. Output rows are top-down; 8-bit
   * returns RGBA8, 16-bit returns RGBA as little-endian u16.
   */
  renderTile(
    p: EditParams,
    region: DetailRegion,
    out: { width: number; height: number; tx: number; ty: number; tw: number; th: number; space: OutputSpace; bitDepth: 8 | 16 },
  ): Uint8Array {
    const gl = this.gl;
    const pipe = this.tilePipe;
    pipe.upload(gl, region.data, region.ow, region.oh, [region.x, region.y, region.w, region.h]);
    this.develop(pipe, p);
    const info = this.source!.info;
    const f = frameDims({ w: info.width, h: info.height }, p.geometry.rotate);
    void f;
    // map the output pixel grid exactly onto the crop on both axes (sizes are rounded independently)
    const lay: Layout = { origin: [-out.tx, -out.ty], scale: 1, cropPx: [out.width, out.height], viewRect: p.geometry.crop, canvas: [out.tw, out.th] };
    const v = { ...defaultView(), bg: [0, 0, 0] as [number, number, number] };
    const fmt = out.bitDepth === 16 ? this.hiFmt : gl.RGBA8;
    const t = (this.outTarget = ensureTarget(gl, this.outTarget, out.tw, out.th, fmt));
    this.pFinal.use();
    this.finalUniforms(p, v, lay, pipe, {
      flipY: false,
      targetH: out.th,
      space: out.space,
      encode: true,
      dither: out.bitDepth === 8,
      overlays: false,
      detail: null,
    });
    this.draw(t, out.tw, out.th);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    let result: Uint8Array;
    if (out.bitDepth === 16) {
      const fl = new Float32Array(out.tw * out.th * 4);
      gl.readPixels(0, 0, out.tw, out.th, gl.RGBA, gl.FLOAT, fl);
      const u = new Uint16Array(fl.length);
      for (let i = 0; i < fl.length; i++) u[i] = Math.max(0, Math.min(65535, Math.round(fl[i] * 65535)));
      result = new Uint8Array(u.buffer);
    } else {
      result = new Uint8Array(out.tw * out.th * 4);
      gl.readPixels(0, 0, out.tw, out.th, gl.RGBA, gl.UNSIGNED_BYTE, result);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return result;
  }

  releaseTilePipe() {
    this.tilePipe.dispose(this.gl);
  }

  dispose() {
    this.preview.dispose(this.gl);
    this.clearDetail();
    this.tilePipe.dispose(this.gl);
    for (const t of this.patchTex.values()) this.gl.deleteTexture(t);
    this.patchTex.clear();
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}

/**
 * Grow a source-uv box so it also covers the source circles (and their heal
 * rings) of spots whose destination overlaps the box.
 */
export function expandForSpots(box: [number, number, number, number], p: EditParams, info: { width: number; height: number }): [number, number, number, number] {
  let [x0, y0, x1, y1] = box;
  const long = Math.max(info.width, info.height);
  for (const sp of p.spots) {
    const rx = (sp.r * 1.25 * long) / info.width;
    const ry = (sp.r * 1.25 * long) / info.height;
    const hit = sp.x + rx >= box[0] && sp.x - rx <= box[2] && sp.y + ry >= box[1] && sp.y - ry <= box[3];
    if (!hit) continue;
    x0 = Math.min(x0, sp.sx - rx, sp.x - rx);
    y0 = Math.min(y0, sp.sy - ry, sp.y - ry);
    x1 = Math.max(x1, sp.sx + rx, sp.x + rx);
    y1 = Math.max(y1, sp.sy + ry, sp.y + ry);
  }
  return [x0, y0, x1, y1];
}

/** crop uv -> source uv for an arbitrary view rect (used for detail regions and overlays). */
export function cropUvToSource(geo: Geometry, info: { width: number; height: number }, u: number, v: number): [number, number] {
  const f = frameDims({ w: info.width, h: info.height }, geo.rotate);
  const px = geo.crop.x + u * geo.crop.w;
  const py = geo.crop.y + v * geo.crop.h;
  const a = (geo.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const X = (px - 0.5) * f.w;
  const Y = (py - 0.5) * f.h;
  let fu = (c * X + s * Y) / f.w + 0.5;
  let fv = (-s * X + c * Y) / f.h + 0.5;
  if (geo.flipH) fu = 1 - fu;
  if (geo.flipV) fv = 1 - fv;
  switch (geo.rotate) {
    case 1:
      return [fv, 1 - fu];
    case 2:
      return [1 - fu, 1 - fv];
    case 3:
      return [1 - fv, fu];
    default:
      return [fu, fv];
  }
}

/** Histogram (256 bins for R, G, B, luminance) from RGBA8 pixels. */
export function computeHistogram(px: Uint8Array): { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; max: number } {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    r[px[i]]++;
    g[px[i + 1]]++;
    b[px[i + 2]]++;
    l[Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])]++;
  }
  let max = 1;
  for (let i = 1; i < 255; i++) max = Math.max(max, r[i], g[i], b[i]);
  return { r, g, b, l, max };
}
