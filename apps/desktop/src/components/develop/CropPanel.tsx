import { ASPECT_PRESETS, constrainCrop, cropWithAspect, defaultGeometry, frameDims, maxCrop, type Geometry } from '@darkroom/core';
import { useDevelop } from '../../state/develop';
import { Section } from '../ui';
import { PSlider } from './PSlider';

export function CropPanel() {
  const geo = useDevelop((s) => s.params.geometry);
  const source = useDevelop((s) => s.source);
  const st = useDevelop.getState;
  if (!source) return null;
  const src = { w: source.info.width, h: source.info.height };
  const f = frameDims(src, geo.rotate);
  const aspectValue = geo.aspect === null ? 'free' : Math.abs(geo.aspect - f.w / f.h) < 1e-3 ? '-1' : String(geo.aspect);

  const setAspect = (v: string) => {
    st().setAndCommit((p) => {
      const fr = frameDims(src, p.geometry.rotate);
      const a = v === 'free' ? null : v === '-1' ? fr.w / fr.h : Number(v);
      p.geometry.aspect = a;
      p.geometry.crop = cropWithAspect(p.geometry, src, a);
    }, 'Crop Aspect');
  };

  const rotate = (dir: 1 | -1) =>
    st().setAndCommit((p) => {
      const g = p.geometry;
      const c = g.crop;
      // transform the crop rectangle with the frame
      g.crop = dir === 1 ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
      // the frame is flip(rotate(source)): with one flip active, +1 turns the other way on screen
      const d = g.flipH !== g.flipV ? -dir : dir;
      g.rotate = (((g.rotate + d) % 4) + 4) % 4 as Geometry['rotate'];
      if (g.aspect) g.aspect = 1 / g.aspect;
      g.crop = constrainCrop(g, src);
    }, dir === 1 ? 'Rotate Right' : 'Rotate Left');

  const flip = (axis: 'h' | 'v') =>
    st().setAndCommit((p) => {
      const g = p.geometry;
      if (axis === 'h') {
        g.flipH = !g.flipH;
        g.crop.x = 1 - g.crop.x - g.crop.w;
      } else {
        g.flipV = !g.flipV;
        g.crop.y = 1 - g.crop.y - g.crop.h;
      }
      g.angle = -g.angle;
      g.crop = constrainCrop(g, src);
    }, axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical');

  return (
    <Section id="crop" title="Crop & Straighten">
      <div className="row">
        <span className="row-label">Aspect</span>
        <select value={aspectValue} onChange={(e) => setAspect(e.target.value)}>
          {ASPECT_PRESETS.map((a) => (
            <option key={a.label} value={a.value === null ? 'free' : String(a.value)}>
              {a.label}
            </option>
          ))}
          {aspectValue !== 'free' && aspectValue !== '-1' && !ASPECT_PRESETS.some((a) => String(a.value) === aspectValue) && <option value={aspectValue}>Custom</option>}
        </select>
      </div>
      <PSlider
        label="Angle"
        get={(p) => p.geometry.angle}
        set={(p, v) => {
          p.geometry.angle = v;
          p.geometry.crop = constrainCrop(p.geometry, src);
        }}
        min={-45}
        max={45}
        step={0.1}
        signedDigits={1}
        commitLabel="Straighten"
      />
      <div className="btn-row">
        <button onClick={() => rotate(-1)} title="Rotate left ([ with ⌘)">
          ⟲ 90°
        </button>
        <button onClick={() => rotate(1)} title="Rotate right">
          ⟳ 90°
        </button>
        <button onClick={() => flip('h')}>Flip H</button>
        <button onClick={() => flip('v')}>Flip V</button>
      </div>
      <div className="btn-row">
        <button
          onClick={() =>
            st().setAndCommit((p) => {
              p.geometry.crop = maxCrop(p.geometry, src, p.geometry.aspect);
            }, 'Fit Crop')
          }
        >
          Maximize
        </button>
        <button onClick={() => st().setAndCommit((p) => (p.geometry = defaultGeometry()), 'Reset Crop')}>Reset</button>
        <button className="primary" onClick={() => st().setTool('crop')}>
          Done
        </button>
      </div>
      <div className="hint">Drag inside to move, drag edges to resize, drag outside the crop to rotate.</div>
    </Section>
  );
}
