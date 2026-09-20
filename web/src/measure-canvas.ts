// Paint a measurement (`measure-shape.ts`) on a 2D canvas, in the coordinates the caller has already projected to.
// Amber, so it is not taken for the red footprint or the blue dot; every stroke has a dark edge under it, so it can be
// read against snow, roofs and shadow alike.

import type { Overlay } from './measure-shape.ts';

const AMBER = '#ffb300';
const EDGE = 'rgba(0, 0, 0, 0.65)';

export function paintOverlay(ctx: CanvasRenderingContext2D, overlay: Overlay): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (overlay.fill && overlay.fill.length >= 3) {
    ctx.beginPath();
    overlay.fill.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 179, 0, 0.22)';
    ctx.fill();
  }
  for (const line of overlay.lines) {
    ctx.beginPath();
    line.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.setLineDash(line.dashed ? [7, 6] : []);
    ctx.lineWidth = 5;
    ctx.strokeStyle = EDGE;
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = AMBER;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const dot of overlay.dots) {
    ctx.beginPath();
    if (dot.kind === 'top') { // a diamond: a point in the air, not on the ground
      ctx.moveTo(dot.at.x, dot.at.y - 8); ctx.lineTo(dot.at.x + 8, dot.at.y); ctx.lineTo(dot.at.x, dot.at.y + 8); ctx.lineTo(dot.at.x - 8, dot.at.y); ctx.closePath();
    } else {
      ctx.arc(dot.at.x, dot.at.y, dot.kind === 'first' ? 7 : 5.5, 0, Math.PI * 2);
    }
    ctx.fillStyle = dot.kind === 'first' ? '#fff' : AMBER;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = dot.kind === 'first' ? AMBER : '#fff';
    ctx.stroke();
  }
  ctx.font = '600 12.5px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  for (const label of overlay.labels) {
    ctx.strokeStyle = EDGE;
    ctx.strokeText(label.text, label.at.x, label.at.y - 11);
    ctx.fillStyle = '#fff';
    ctx.fillText(label.text, label.at.x, label.at.y - 11);
  }
  ctx.restore();
}
