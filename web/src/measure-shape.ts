// What to draw for a measurement, in whatever space `project` puts a ground point in: pixels of the photo pane, or
// longitude and latitude on the map. It only decides which dots, lines, fill and labels there are; the pane paints
// them on a canvas (`measure-canvas.ts`) and the scene makes map layers from them (`measure-layer.ts`).

import { formatAreaShort, formatFeet, type Ground } from './measure.ts';
import { isHeightTool, sides, type MeasureModel } from './measure-model.ts';

export interface XY { x: number; y: number }

export interface Overlay {
  /** `first` is where the measurement began, `top` the point in the air of the height tools. */
  dots: { at: XY; kind: 'vertex' | 'first' | 'top' }[];
  lines: { points: XY[]; dashed: boolean }[];
  /** The outline to tint, for the area tools. */
  fill: XY[] | null;
  labels: { at: XY; text: string }[];
}

/**
 * The drawing for the model as it stands. `project` gives where a ground point is in the drawing's space, or null when
 * it has no place there (behind the camera): what depends on such a point is left out.
 */
/** A ground point, with the photo it was picked in when it has one: the scene puts it where that photo shows it. */
export type Placed = Ground & { frame?: string };

export function overlayOf(model: MeasureModel, project: (ground: Placed) => XY | null): Overlay {
  const overlay: Overlay = { dots: [], lines: [], fill: null, labels: [] };
  const tool = model.tool;
  if (!tool) return overlay;
  const middle = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  if (isHeightTool(tool)) {
    const base = model.vertices[0];
    const bottom = base && project(base);
    if (!base || !bottom) return overlay;
    overlay.dots.push({ at: bottom, kind: 'first' });
    const top = model.top;
    const upper = top && project(top);
    if (top && upper) {
      overlay.lines.push({ points: [bottom, upper], dashed: tool === 'location3d' });
      overlay.dots.push({ at: upper, kind: 'top' });
      if (tool === 'height') overlay.labels.push({ at: middle(bottom, upper), text: formatFeet(model.rise!) });
    }
    return overlay;
  }

  const placed = model.vertices.map((v) => ({ v, at: project(v) })).filter((p): p is { v: typeof p.v; at: XY } => p.at !== null);
  placed.forEach((p, i) => overlay.dots.push({ at: p.at, kind: i === 0 ? 'first' : 'vertex' }));
  if (tool === 'surface') return overlay;

  const closed = (tool === 'area' || tool === 'area3d') && placed.length >= 3;
  if (placed.length >= 2) {
    const points = placed.map((p) => p.at);
    overlay.lines.push({ points: closed ? [...points, points[0]!] : points, dashed: false });
    if (closed) overlay.fill = points;
  }
  // Only the sides whose two ends both have a place are labelled; the numbers come from the ground points themselves.
  const ground = placed.map((p) => p.v);
  const mode = tool === 'distance3d' ? '3d' : '2d';
  if (tool === 'distance' || tool === 'distance3d' || closed) {
    sides(ground, mode, closed).forEach((side, i) => {
      const a = placed[i]!.at, b = placed[(i + 1) % placed.length]!.at;
      overlay.labels.push({ at: middle(a, b), text: formatFeet(side.feet) });
    });
  }
  if (closed) {
    const cx = placed.reduce((s, p) => s + p.at.x, 0) / placed.length, cy = placed.reduce((s, p) => s + p.at.y, 0) / placed.length;
    overlay.labels.push({ at: { x: cx, y: cy }, text: formatAreaShort(model.area) });
  }
  return overlay;
}
