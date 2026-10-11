/**
 * End-to-end self-test inside the real app webview. Enabled only when the
 * app is launched with DARKROOM_SELFTEST=1 (see scripts/selftest.sh), against
 * an isolated catalog (DARKROOM_DATA_DIR).
 */
import { invoke } from '@tauri-apps/api/core';
import { computeHistogram } from '../engine/Engine';
import { backend } from '../ipc/backend';
import { useDevelop } from '../state/develop';
import { getEngine } from '../state/engineHub';
import { useLibrary } from '../state/library';
import { useUi } from '../state/ui';
import { newMask } from '@darkroom/core';
import { defaultExportSettings, exportImages } from './background';
import { patchAssetState } from './patchAssets';

interface Config {
  enabled: boolean;
  samplesDir: string;
  outDir: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(f: () => boolean, ms = 30000, what = 'condition') {
  const t0 = performance.now();
  while (!f()) {
    if (performance.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

export async function maybeRunSelftest() {
  let cfg: Config;
  try {
    cfg = await invoke<Config>('selftest_config');
  } catch {
    return;
  }
  if (!cfg.enabled) return;
  const log = (m: string) => backend().log('info', `SELFTEST ${m}`);
  const fail = async (m: string) => {
    backend().log('error', `SELFTEST FAIL ${m}`);
    await sleep(300);
    await invoke('exit_app', { code: 1 });
  };
  try {
    log(`start; samples=${cfg.samplesDir} out=${cfg.outDir}; UA=${navigator.userAgent}`);
    const gl = document.createElement('canvas').getContext('webgl2');
    log(`webgl2=${!!gl} float_rt=${!!gl?.getExtension('EXT_color_buffer_float')} float_linear=${!!gl?.getExtension('OES_texture_float_linear')} renderer=${gl?.getParameter(gl.RENDERER)}`);

    // 1. import
    let done = false;
    const off = backend().onImportDone((s) => {
      done = true;
      log(`import done ${JSON.stringify(s)}`);
    });
    await backend().importPaths([cfg.samplesDir]);
    await until(() => done, 120000, 'import');
    off();
    await useLibrary.getState().refresh();
    const images = useLibrary.getState().images;
    log(`library has ${images.length} images`);
    if (images.length < 5) return fail(`expected >= 5 images, got ${images.length}`);

    // 1b. preset catalog: save, patch, upsert by (group, name), delete
    const b = backend();
    const pid = await b.savePreset('Selftest', 'Filter A', JSON.stringify({ contrast: 12 }), 'selftest filter', 'user');
    await b.updatePreset(pid, { name: 'Filter B', favorite: true });
    const preset = (await b.listPresets()).find((x) => x.id === pid);
    if (!preset || preset.name !== 'Filter B' || preset.favorite !== true || preset.description !== 'selftest filter') {
      return fail(`preset update not persisted: ${JSON.stringify(preset)}`);
    }
    const pid2 = await b.savePreset('Selftest', 'Filter B', JSON.stringify({ contrast: 20 }), '', 'user');
    if (pid2 !== pid) return fail(`preset upsert created a new row (${pid2} != ${pid})`);
    await b.deletePreset(pid);
    if ((await b.listPresets()).some((x) => x.id === pid)) return fail('preset not deleted');
    log(`preset catalog ok (id ${pid})`);

    // 2. develop each image
    useUi.getState().setModule('develop');
    for (const img of images) {
      const t0 = performance.now();
      useLibrary.getState().select(img.id);
      await until(() => useDevelop.getState().imageId === img.id && !!useDevelop.getState().source, 60000, `open ${img.filename}`);
      await sleep(250);
      const e = getEngine();
      if (!e) return fail('no engine');
      const ds = useDevelop.getState();
      e.sync(ds.source!, ds.params, ds.base);
      const px = e.renderSmall(256, 170);
      if (!px) return fail('renderSmall returned null');
      const h = computeHistogram(px);
      let mean = 0;
      for (let i = 0; i < 256; i++) mean += i * h.l[i];
      mean /= 256 * 170;
      log(`opened ${img.filename} (${img.format}, ${img.width}x${img.height}) in ${Math.round(performance.now() - t0)} ms; mean luma ${mean.toFixed(1)}`);
      if (mean < 5 || mean > 250) return fail(`${img.filename} renders as a flat image (mean ${mean})`);
    }

    // 3. edit the first raw: tone, color, mask, crop
    const raw = images.find((i) => i.format === 'raw') ?? images[0];
    useLibrary.getState().select(raw.id);
    await until(() => useDevelop.getState().imageId === raw.id && !!useDevelop.getState().source, 60000, 'open raw');
    const d = useDevelop.getState();
    d.setAndCommit((p) => {
      p.exposure = 0.4;
      p.highlights = -60;
      p.shadows = 50;
      p.clarity = 20;
      p.vibrance = 25;
      p.detail.nrLuma = 20;
      p.texture = 10;
      p.spots = [
        { id: 's1', mode: 'heal', x: 0.78, y: 0.16, sx: 0.6, sy: 0.16, r: 0.04, feather: 0.3, opacity: 1 },
        { id: 's2', mode: 'clone', x: 0.5, y: 0.7, sx: 0.4, sy: 0.7, r: 0.02, feather: 0.3, opacity: 1 },
      ];
      p.geometry.angle = 3;
      p.geometry.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      p.toneCurve.points.rgb = [
        [0, 0],
        [0.3, 0.25],
        [0.7, 0.76],
        [1, 1],
      ];
      p.masks.push({
        id: 'selftest',
        name: 'Sky',
        enabled: true,
        invert: false,
        kind: 'linear',
        amount: 100,
        linear: { x0: 0.5, y0: 0.05, x1: 0.5, y1: 0.45 },
        radial: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, angle: 0, feather: 50 },
        brush: { strokes: [{ points: [[0.7, 0.8], [0.8, 0.85]], size: 0.03, feather: 0.5, flow: 1, erase: false }] },
        shape: { points: [], feather: 0.02 },
        range: { mode: 'none', lumMin: 0, lumMax: 100, lumFeather: 20, hue: 0, sat: 0.5, amount: 50 },
        adj: { exposure: -0.5, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temp: -20, tint: 0, saturation: 20, clarity: 0, dehaze: 0, texture: 0 },
      });
    }, 'Selftest edit');
    // zoom to exercise detail regions
    d.setView({ mode: 'zoom', zoom: 1, center: [0.4, 0.7] });
    await sleep(1500);
    log(`zoomed; detail region ${JSON.stringify(getEngine()?.detailRegion)}`);
    d.setView({ mode: 'fit' });
    await sleep(1500);
    const row = useLibrary.getState().images.find((i) => i.id === raw.id);
    log(`edited=${row?.edited} thumbRev=${row?.thumbRev} history=${useDevelop.getState().history.length}`);

    // 3b. generative fill: a stored PNG composited through a shape mask (no network)
    {
      const img = images.find((i) => i.id !== raw.id && i.format !== 'raw') ?? images.find((i) => i.id !== raw.id);
      if (!img) return fail('no second image for the fill test');
      useLibrary.getState().select(img.id);
      await until(() => useDevelop.getState().imageId === img.id && !!useDevelop.getState().source, 60000, 'open fill image');
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const cx = c.getContext('2d');
      if (!cx) return fail('no 2d canvas');
      cx.fillStyle = 'rgb(255,0,255)';
      cx.fillRect(0, 0, 64, 64);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!blob) return fail('canvas toBlob failed');
      const hash = await b.savePatch(new Uint8Array(await blob.arrayBuffer()));
      useDevelop.getState().setAndCommit((p) => {
        const m = newMask('shape', p.masks.length);
        m.id = 'fillmask';
        m.shape = { points: [[0.35, 0.35], [0.65, 0.35], [0.65, 0.65], [0.35, 0.65]], feather: 0.01 };
        p.masks.push(m);
        p.patches.push({ id: 'fill1', asset: hash, rect: [0.3, 0.3, 0.4, 0.4], area: [0.35, 0.35, 0.3, 0.3], maskId: 'fillmask', feather: 0.01, opacity: 1, enabled: true, prompt: 'selftest', model: 'none', ev: 0 });
      }, 'Selftest fill');
      await until(() => patchAssetState(hash) === 'ready', 10000, 'patch asset');
      await sleep(500);
      const e = getEngine();
      if (!e) return fail('no engine');
      const ds = useDevelop.getState();
      e.sync(ds.source!, ds.params, ds.base);
      const px = e.renderSmall(200, 200);
      if (!px) return fail('fill renderSmall returned null');
      const o = (100 * 200 + 100) * 4;
      const [r, g, bl] = [px[o], px[o + 1], px[o + 2]];
      log(`fill centre pixel ${r},${g},${bl} (asset ${hash})`);
      if (!(r > 150 && g < 110 && bl > 150)) return fail(`fill not composited: centre ${r},${g},${bl}`);
      const sf = { ...defaultExportSettings(), folder: cfg.outDir, template: '{name}-fill', overwrite: true };
      const rf = await exportImages([img.id], sf, () => {}, () => false);
      log(`fill export ${JSON.stringify(rf)}`);
      if (rf.errors.length) return fail('fill export errors');
      log('generative fill ok');
    }

    // 4. export
    const s1 = { ...defaultExportSettings(), folder: cfg.outDir, template: '{name}-edited', overwrite: true };
    const r1 = await exportImages([raw.id], s1, () => {}, () => false);
    log(`jpeg export ${JSON.stringify(r1)}`);
    const s2 = { ...defaultExportSettings(), folder: cfg.outDir, format: 'tiff' as const, bitDepth: 16 as const, colorSpace: 'prophoto' as const, resize: true, longEdge: 1500, overwrite: true };
    const r2 = await exportImages(images.slice(0, 3).map((i) => i.id), s2, () => {}, () => false);
    log(`tiff export ${JSON.stringify(r2)}`);
    const s3 = { ...defaultExportSettings(), folder: cfg.outDir, template: '{name}-asis', overwrite: true };
    const r3 = await exportImages(images.map((i) => i.id), s3, () => {}, () => false);
    log(`jpeg as-is export ${r3.written.length} files, errors ${JSON.stringify(r3.errors)}`);
    if (r1.errors.length || r2.errors.length || r3.errors.length) return fail('export errors');

    log('PASS');
    await sleep(300);
    await invoke('exit_app', { code: 0 });
  } catch (e) {
    await fail(String(e));
  }
}
