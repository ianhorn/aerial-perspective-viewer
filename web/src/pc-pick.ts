// Drawing the area to load a point cloud for: two clicks on the map, the corners of a rectangle on the screen, with the rectangle following
// the pointer between them. Like the drawing tools' rectangle, it is made in screen pixels (so it is square to the screen even if the map is
// turned) and becomes a polygon of longitude and latitude. No DOM here.

import { screenRectangle } from './draw-geometry.ts';
import type { View } from './draw-tool.ts';
import type { LonLat } from './pc-aoi.ts';

/** The smallest rectangle, in pixels, in each direction. */
const MIN_PX = 8;

export class AreaPicker {
  private readonly view: View;
  private readonly onPicked: (ring: LonLat[]) => void;
  private readonly onChange: () => void;
  private first: { x: number; y: number } | null = null;
  private cursor: { x: number; y: number } | null = null;
  active = false;
  /** Something to tell the user, such as why a click was ignored. */
  notice: string | null = null;

  constructor(view: View, onPicked: (ring: LonLat[]) => void, onChange: () => void = () => undefined) {
    this.view = view;
    this.onPicked = onPicked;
    this.onChange = onChange;
  }

  start(): void {
    this.active = true;
    this.first = null;
    this.cursor = null;
    this.notice = null;
    this.onChange();
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active = false;
    this.first = null;
    this.cursor = null;
    this.notice = null;
    this.onChange();
    return true;
  }

  get prompt(): string {
    return this.first ? 'Click the opposite corner.' : 'Click one corner of the area.';
  }

  /** The rectangle so far, as a polygon: from the first corner to the pointer. Null until there is one that has some size. */
  preview(): LonLat[] | null {
    if (!this.first || !this.cursor) return null;
    if (Math.abs(this.first.x - this.cursor.x) < 1 || Math.abs(this.first.y - this.cursor.y) < 1) return null;
    return screenRectangle(this.first, this.cursor).map((p) => this.view.unproject(p));
  }

  move(at: { x: number; y: number }): void {
    if (!this.active || !this.first) return;
    this.cursor = at;
    this.onChange();
  }

  click(at: { x: number; y: number }): void {
    if (!this.active) return;
    this.notice = null;
    if (!this.first) {
      this.first = at;
      this.cursor = at;
      this.onChange();
      return;
    }
    if (Math.abs(at.x - this.first.x) < MIN_PX || Math.abs(at.y - this.first.y) < MIN_PX) {
      this.notice = 'Click a corner farther from the first one.';
      this.onChange();
      return;
    }
    const ring = screenRectangle(this.first, at).map((p) => this.view.unproject(p));
    this.active = false;
    this.first = null;
    this.cursor = null;
    this.onChange();
    this.onPicked(ring);
  }
}
