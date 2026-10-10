import { camToPro, mulVec, type Mat3, type SourceColor, type Vec3 } from '@darkroom/core';

export interface SourceInfo {
  photoId: number;
  /** full-resolution, upright dimensions */
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  color: { isRaw: boolean; xyzToCam: number[]; asShotMul: number[]; space: string };
}

export interface LoadedSource {
  info: SourceInfo;
  /** Linear camera RGB, 0..1, previewWidth * previewHeight * 3 */
  data: Float32Array;
  color: SourceColor;
  /** Estimated airlight (bright atmospheric level) for dehaze, in linear ProPhoto. */
  airlight: number;
}

const U16 = 1 / 65535;

export function u16ToFloat(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] * U16;
  return out;
}

export function parsePreview(buf: ArrayBuffer): LoadedSource {
  const hlen = new DataView(buf).getUint32(0, true);
  const json = new TextDecoder().decode(new Uint8Array(buf, 4, hlen));
  const info = JSON.parse(json) as SourceInfo;
  const n = info.previewWidth * info.previewHeight * 3;
  const data = u16ToFloat(new Uint16Array(buf, 4 + hlen, n));
  const color: SourceColor = {
    xyzToCam: info.color.xyzToCam as Mat3,
    asShotMul: info.color.asShotMul as Vec3,
    isRaw: info.color.isRaw,
  };
  return { info, data, color, airlight: estimateAirlight(data, color) };
}

export function parseRegion(buf: ArrayBuffer): { w: number; h: number; data: Float32Array } {
  const dv = new DataView(buf);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  return { w, h, data: u16ToFloat(new Uint16Array(buf, 8, w * h * 3)) };
}

function estimateAirlight(data: Float32Array, color: SourceColor): number {
  const m = camToPro(color);
  const mul = color.asShotMul;
  const step = Math.max(1, Math.floor(data.length / 3 / 40000));
  const lum: number[] = [];
  for (let i = 0; i < data.length; i += 3 * step) {
    const p = mulVec(m, [data[i] * mul[0], data[i + 1] * mul[1], data[i + 2] * mul[2]]);
    lum.push(0.288 * p[0] + 0.712 * p[1]);
  }
  lum.sort((a, b) => a - b);
  const v = lum[Math.floor(lum.length * 0.995)] ?? 1;
  return Math.max(0.05, v);
}

/** Mean camera RGB in a small window (for the white balance eyedropper). */
export function sampleCamera(src: LoadedSource, u: number, v: number, radius = 3): [number, number, number] {
  const { previewWidth: w, previewHeight: h } = src.info;
  const cx = Math.round(u * (w - 1));
  const cy = Math.round(v * (h - 1));
  const acc = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const i = (y * w + x) * 3;
      acc[0] += src.data[i];
      acc[1] += src.data[i + 1];
      acc[2] += src.data[i + 2];
      n++;
    }
  }
  return [acc[0] / n, acc[1] / n, acc[2] / n];
}

/** Gray-world estimate of the illuminant in camera space (for Auto white balance). */
export function grayWorld(src: LoadedSource): [number, number, number] {
  const d = src.data;
  const acc = [0, 0, 0];
  let n = 0;
  const step = Math.max(1, Math.floor(d.length / 3 / 60000)) * 3;
  for (let i = 0; i < d.length; i += step) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    if (mx > 0.95 || mx < 0.01) continue;
    acc[0] += d[i];
    acc[1] += d[i + 1];
    acc[2] += d[i + 2];
    n++;
  }
  if (!n) return [1, 1, 1];
  return [acc[0] / n, acc[1] / n, acc[2] / n];
}
