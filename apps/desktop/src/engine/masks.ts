import type { Mask } from '@darkroom/core';

/**
 * Rasterize a mask's geometry (not its range component) into a grayscale
 * canvas in source UV space. White = full effect.
 */
export function rasterizeMask(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  m: Mask,
  w: number,
  h: number,
  scratch: { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D },
) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const long = Math.max(w, h);
  if (m.kind === 'linear') {
    const { x0, y0, x1, y1 } = m.linear;
    const g = ctx.createLinearGradient(x0 * w, y0 * h, x1 * w, y1 * h);
    g.addColorStop(0, '#fff');
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else if (m.kind === 'radial') {
    const { cx, cy, rx, ry, angle, feather } = m.radial;
    ctx.translate(cx * w, cy * h);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.scale(Math.max(rx * long, 0.5), Math.max(ry * long, 0.5));
    const inner = Math.max(0, 1 - feather / 100) * 0.999;
    const g = ctx.createRadialGradient(0, 0, inner, 0, 0, 1);
    g.addColorStop(0, '#fff');
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
  } else if (m.kind === 'brush') {
    const s = scratch;
    for (const stroke of m.brush.strokes) {
      if (!stroke.points.length) continue;
      s.ctx.save();
      s.ctx.globalCompositeOperation = 'source-over';
      s.ctx.clearRect(0, 0, w, h);
      // Draw the stroke path once (no build-up where it overlaps itself) and
      // soften it with a shadow blur offset back onto the canvas.
      const r = Math.max(1, stroke.size * long);
      const soft = r * stroke.feather;
      const core = Math.max(0.5, r - soft * 0.5);
      const OFF = 100000;
      s.ctx.lineCap = 'round';
      s.ctx.lineJoin = 'round';
      s.ctx.lineWidth = core * 2;
      s.ctx.strokeStyle = '#fff';
      s.ctx.shadowColor = '#fff';
      s.ctx.shadowBlur = soft;
      s.ctx.shadowOffsetX = OFF;
      s.ctx.beginPath();
      const p0 = stroke.points[0];
      s.ctx.moveTo(p0[0] * w - OFF, p0[1] * h);
      if (stroke.points.length === 1) s.ctx.lineTo(p0[0] * w - OFF + 0.01, p0[1] * h);
      for (let i = 1; i < stroke.points.length; i++) s.ctx.lineTo(stroke.points[i][0] * w - OFF, stroke.points[i][1] * h);
      s.ctx.stroke();
      s.ctx.restore();
      ctx.globalAlpha = stroke.flow;
      ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
      ctx.drawImage(s.canvas as CanvasImageSource, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  } else if (m.kind === 'shape') {
    const pts = m.shape.points;
    if (pts.length >= 3) {
      const s = scratch;
      s.ctx.save();
      s.ctx.globalCompositeOperation = 'source-over';
      s.ctx.clearRect(0, 0, w, h);
      // Same trick as the brush: fill the polygon far off-canvas and let only
      // its blurred shadow land on the canvas, which gives a soft edge.
      const OFF = 100000;
      s.ctx.fillStyle = '#fff';
      s.ctx.shadowColor = '#fff';
      s.ctx.shadowBlur = Math.max(0, m.shape.feather * long);
      s.ctx.shadowOffsetX = OFF;
      s.ctx.beginPath();
      s.ctx.moveTo(pts[0][0] * w - OFF, pts[0][1] * h);
      for (let i = 1; i < pts.length; i++) s.ctx.lineTo(pts[i][0] * w - OFF, pts[i][1] * h);
      s.ctx.closePath();
      s.ctx.fill('nonzero');
      s.ctx.restore();
      ctx.drawImage(s.canvas as CanvasImageSource, 0, 0);
    }
  }
  ctx.restore();
}

export function maskGeometryKey(m: Mask): string {
  switch (m.kind) {
    case 'linear':
      return JSON.stringify([m.kind, m.linear]);
    case 'radial':
      return JSON.stringify([m.kind, m.radial]);
    case 'brush':
      return JSON.stringify([m.kind, m.brush]);
    case 'shape':
      return JSON.stringify([m.kind, m.shape]);
  }
}
