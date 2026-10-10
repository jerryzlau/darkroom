/** Small WebGL2 helpers: programs with cached uniform locations, textures, framebuffers. */

export class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  private units = new Map<string, number>();
  private nextUnit = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    vert: string,
    frag: string,
    readonly name: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vert, name);
    const fs = compile(gl, gl.FRAGMENT_SHADER, frag, name);
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`link ${name}: ${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.prog = p;
  }

  use() {
    this.gl.useProgram(this.prog);
    this.nextUnit = 0;
    this.units.clear();
  }

  loc(name: string) {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.locs.set(name, l);
    }
    return l;
  }

  f(name: string, ...v: number[]) {
    const l = this.loc(name);
    if (!l) return;
    const gl = this.gl;
    if (v.length === 1) gl.uniform1f(l, v[0]);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
    else gl.uniform4f(l, v[0], v[1], v[2], v[3]);
  }

  i(name: string, v: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }

  b(name: string, v: boolean) {
    this.i(name, v ? 1 : 0);
  }

  bv2(name: string, a: boolean, b: boolean) {
    const l = this.loc(name);
    if (l) this.gl.uniform2i(l, a ? 1 : 0, b ? 1 : 0);
  }

  fv(name: string, v: Float32Array | number[]) {
    const l = this.loc(name);
    if (l) this.gl.uniform1fv(l, v);
  }

  v4(name: string, v: Float32Array | number[]) {
    const l = this.loc(name);
    if (l) this.gl.uniform4fv(l, v);
  }

  /** Row-major 3x3 matrix. */
  m3(name: string, m: ArrayLike<number>) {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix3fv(l, true, Array.from(m));
  }

  tex(name: string, t: WebGLTexture | null, target: number = this.gl.TEXTURE_2D) {
    const l = this.loc(name);
    const gl = this.gl;
    let unit = this.units.get(name);
    if (unit === undefined) {
      unit = this.nextUnit++;
      this.units.set(name, unit);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, t);
    if (l) gl.uniform1i(l, unit);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, name: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => `${i + 1}: ${l}`);
    throw new Error(`compile ${name}: ${log}\n${lines.join('\n')}`);
  }
  return s;
}

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  format: number;
}

export function createTexture(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internal: number,
  format: number,
  type: number,
  data: ArrayBufferView | null = null,
  filter: number = gl.LINEAR,
): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function createTarget(gl: WebGL2RenderingContext, w: number, h: number, format: number = gl.RGBA16F): Target {
  const isFloat = format === gl.RGBA16F || format === gl.RGBA32F;
  const tex = createTexture(gl, w, h, format, gl.RGBA, isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
  return { tex, fbo, w, h, format };
}

export function deleteTarget(gl: WebGL2RenderingContext, t: Target | null) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

/** Reuse a target when its size and format match, otherwise recreate it. */
export function ensureTarget(
  gl: WebGL2RenderingContext,
  t: Target | null,
  w: number,
  h: number,
  format: number = gl.RGBA16F,
): Target {
  if (t && t.w === w && t.h === h && t.format === format) return t;
  deleteTarget(gl, t);
  return createTarget(gl, w, h, format);
}
