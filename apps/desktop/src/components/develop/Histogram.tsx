import { useEffect, useRef } from 'react';
import { useDevelop } from '../../state/develop';
import { useHistogram } from '../DevelopCanvas';

export function Histogram() {
  const h = useHistogram((s) => s.h);
  const ref = useRef<HTMLCanvasElement>(null);
  const image = useDevelop((s) => s.image);
  const showClip = useDevelop((s) => s.view.showClipping);
  const setView = useDevelop((s) => s.setView);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth * dpr;
    const H = c.clientHeight * dpr;
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!h) return;
    ctx.globalCompositeOperation = 'lighter';
    const norm = (v: number) => Math.sqrt(Math.min(1, v / h.max));
    const chans: [Uint32Array, string][] = [
      [h.r, 'rgba(220,60,60,0.75)'],
      [h.g, 'rgba(60,200,80,0.75)'],
      [h.b, 'rgba(70,110,235,0.75)'],
    ];
    for (const [arr, color] of chans) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - norm(arr[i]) * H * 0.95);
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((i / 4) * W, 0);
      ctx.lineTo((i / 4) * W, H);
      ctx.stroke();
    }
  }, [h]);

  const total = h ? h.l.reduce((a, b) => a + b, 0) : 1;
  const lowClip = h ? (h.r[0] + h.g[0] + h.b[0]) / 3 / total > 0.002 : false;
  const highClip = h ? (h.r[255] + h.g[255] + h.b[255]) / 3 / total > 0.002 : false;
  const meta = image
    ? [image.iso ? `ISO ${image.iso}` : null, image.focalLength ? `${Math.round(image.focalLength)} mm` : null, image.fnumber ? `ƒ/${image.fnumber.toFixed(1)}` : null, image.exposureTime]
        .filter(Boolean)
        .join('   ')
    : '';
  return (
    <div className="histogram">
      <canvas ref={ref} />
      <button className={`clip-ind left ${lowClip ? 'hot' : ''} ${showClip ? 'on' : ''}`} title="Show clipping (J)" onClick={() => setView({ showClipping: !showClip })}>
        ◣
      </button>
      <button className={`clip-ind right ${highClip ? 'hot' : ''} ${showClip ? 'on' : ''}`} title="Show clipping (J)" onClick={() => setView({ showClipping: !showClip })}>
        ◢
      </button>
      <div className="histo-meta">{meta}</div>
    </div>
  );
}
