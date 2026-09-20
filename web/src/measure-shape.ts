// What to draw for a measurement, in whatever space `project` puts a ground point in: pixels of the photo pane, or
// longitude and latitude on the map. It only decides which dots, lines, fill and labels there are; the pane paints
// them on a canvas (`measure-canvas.ts`) and the scene makes map layers from them (`measure-layer.ts`).

import { formatAreaShort, formatFeet, type Ground } from './measure.ts';
import { isHeightTool, sides, type MeasureModel } from './measure-model.ts';

export interface XY { x: number; y: number }

export interface Overlay {
  /** `first` is where the measurement began, `top` the point in the air of the height tools. */
  dots: { at: XY; kind: 'vertex' | 'first' | 'top' }[];
  /** `tone` colours the guides of the live height preview: the vertical to compare with, the line to the cursor, and that line when it is plumb. */
  lines: { points: XY[]; dashed: boolean; tone?: 'plumb' | 'band' | 'ok' }[];
  /** The outline to tint, for the area tools. */
  fill: XY[] | null;
  labels: { at: XY; text: string }[];
}

/**
 * The drawing for the model as it stands. `project` gives where a ground point is in the drawing's space, or null when
 * it has no place there (behind the camera): what depends on such a point is left out.
 */
/**
 * The live preview while the top of a height is being placed: where the cursor is (in the drawing's space), the height
 * that its picture position means (`rise`, from the vertical line above the base), and how close to that vertical the
 * cursor has to be, in the drawing's own units, to count as plumb.
 */
export interface Preview { cursor: XY; rise: number; tolerance: number }

/** A ground point, with the photo it was picked in when it has one: the scene puts it where that photo shows it. */
export type Placed = Ground & { frame?: string };

export function overlayOf(model: MeasureModel, project: (ground: Placed) => XY | null, preview: Preview | null = null): Overlay {
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
    } else if (preview && model.needsTop) {
      // The top is not placed yet: draw the true vertical above the base, a line from the base to the cursor, and the height the
      // cursor means. The line to the cursor turns green when the cursor is on the vertical, so it is easy to see what is plumb.
      const at = (h: number): XY | null => project({ x: base.x, y: base.y, z: base.z + h, frame: base.frame });
      const along = at(preview.rise);
      const low = at(Math.min(0, preview.rise)), high = at(Math.max(80, preview.rise * 1.6));
      if (along && low && high) {
        const plumb = Math.hypot(preview.cursor.x - along.x, preview.cursor.y - along.y) <= preview.tolerance;
        overlay.lines.push({ points: [low, high], dashed: true, tone: 'plumb' });
        if (!plumb) overlay.lines.push({ points: [preview.cursor, along], dashed: true, tone: 'band' }); // how far the cursor is from the vertical
        overlay.lines.push({ points: [bottom, preview.cursor], dashed: false, tone: plumb ? 'ok' : 'band' });
        overlay.dots.push({ at: along, kind: 'top' });
        overlay.labels.push({ at: preview.cursor, text: `${formatFeet(preview.rise)}${plumb ? ' · plumb' : ''}` });
      }
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
