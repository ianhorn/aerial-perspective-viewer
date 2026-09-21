// The drawing tools' behaviour: which tool is on, the shape being drawn, what is selected, and what a click, a drag or a key does.
// It knows nothing of the map or the page: it is given a way to turn a screen position into a place and back, and it works on a
// `DrawStore`. That keeps it testable, and keeps the map wiring (`main.ts`) to passing events in.
//
// A shape being dragged is not written to the store until the pointer is let go (so a drag is one step of the history, not
// hundreds); until then `features()` shows it moved.

import { groundDistanceM, rectangleWithCorner, screenRectangle, type LonLat } from './draw-geometry.ts';
import { edgeAt, handleAt, handlesOf, hitTest, type Handle, type Pixel } from './draw-hit.ts';
import type { DrawFeature, DrawStore, ShapeKind } from './draw-model.ts';

export type ToolId = 'select' | 'point' | 'line' | 'polygon' | 'rectangle' | 'circle' | 'text';

export const TOOL_LIST: readonly { id: ToolId; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Select, move and reshape what is drawn' },
  { id: 'point', label: 'Point', hint: 'Place points' },
  { id: 'line', label: 'Line', hint: 'Draw a line' },
  { id: 'polygon', label: 'Polygon', hint: 'Draw an area' },
  { id: 'rectangle', label: 'Rectangle', hint: 'Draw a rectangle from two corners' },
  { id: 'circle', label: 'Circle', hint: 'Draw a circle from its centre and a point on its edge' },
  { id: 'text', label: 'Text', hint: 'Place a piece of text' },
];

/** The shape being drawn: its fixed points so far, and where the pointer is. */
export interface Draft { tool: 'line' | 'polygon' | 'rectangle' | 'circle'; points: LonLat[]; cursor: LonLat | null }

export interface View {
  project(at: LonLat): Pixel;
  unproject(at: Pixel): LonLat;
}

/** How near, in pixels, a new point of a line may be to the last one before it is taken for the second click of a double-click. */
const SAME_SPOT_PX = 4;
/** How far the pointer must move, in pixels, before a press on a shape becomes a drag (so a click does not nudge it). */
const DRAG_START_PX = 4;

/** What to tell the user to do next. */
export function promptFor(tool: ToolId, fixedPoints: number): string {
  switch (tool) {
    case 'select': return 'Click a shape to select it. Drag it, or its handles, to change it. Double-click an edge to add a point, or a point to remove it.';
    case 'point': return 'Click the map to place a point.';
    case 'text': return 'Click the map where the text goes.';
    case 'line': return fixedPoints === 0 ? 'Click the first point of the line.' : 'Click to add points. Double-click or press Enter to finish.';
    case 'polygon': return fixedPoints === 0 ? 'Click the first corner of the area.' : 'Click to add corners. Double-click or press Enter to finish.';
    case 'rectangle': return fixedPoints === 0 ? 'Click one corner of the rectangle.' : 'Click the opposite corner.';
    case 'circle': return fixedPoints === 0 ? 'Click the centre of the circle.' : 'Click a point on its edge.';
  }
}

type Drag =
  | { type: 'handle'; id: string; handle: Handle; started: boolean; from: Pixel }
  | { type: 'body'; id: string; started: boolean; from: Pixel; fromLonLat: LonLat; original: DrawFeature };

export interface DrawControllerOptions {
  /** Called when a feature is made by drawing (not by undo), so the page can put the cursor in its label. */
  onCreate?: (feature: DrawFeature) => void;
}

export class DrawController {
  private readonly store: DrawStore;
  private readonly view: View;
  private readonly options: DrawControllerOptions;
  private readonly listeners = new Set<() => void>();
  private drag: Drag | null = null;
  private dragged: DrawFeature | null = null; // the feature as it looks while being dragged
  private swallowClick = false;

  /** The tool that is on; null means drawing is off (the map behaves as before, and the drawing is only shown). */
  tool: ToolId | null = null;
  selected: string | null = null;
  draft: Draft | null = null;
  /** Something the user should be told, such as why a shape was not made. Cleared by the next action. */
  notice: string | null = null;

  constructor(store: DrawStore, view: View, options: DrawControllerOptions = {}) {
    this.store = store;
    this.view = view;
    this.options = options;
    store.subscribe(() => {
      if (this.selected && !store.get(this.selected)) this.selected = null; // deleted, or undone
      this.changed();
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  get active(): boolean {
    return this.tool !== null;
  }
  get dragging(): boolean {
    return this.drag !== null && this.drag.started;
  }
  get selectedFeature(): DrawFeature | undefined {
    return this.selected ? this.features().find((f) => f.id === this.selected) : undefined;
  }

  /** What to show: the stored features, with the one being dragged as it is now. */
  features(): readonly DrawFeature[] {
    const dragged = this.dragged;
    return dragged ? this.store.features.map((f) => (f.id === dragged.id ? dragged : f)) : this.store.features;
  }

  setTool(tool: ToolId | null): void {
    this.abandonDrag();
    this.draft = null;
    this.notice = null;
    if (tool !== 'select') this.selected = null;
    this.tool = tool;
    this.changed();
  }

  select(id: string | null): void {
    this.selected = id !== null && this.store.get(id) ? id : null;
    this.notice = null;
    this.changed();
  }

  /** The prompt for what is on now. */
  get prompt(): string {
    return this.tool ? promptFor(this.tool, this.draft?.points.length ?? 0) : '';
  }

  /** The handles of the selected feature, for the map to draw. */
  get handles(): Handle[] {
    const f = this.selectedFeature;
    return this.tool === 'select' && f ? handlesOf(f) : [];
  }

  /**
   * The shape being drawn as a feature, for the map to draw dashed: the fixed points and the pointer's place. A polygon with
   * fewer than three places yet is shown as a line. Null when there is nothing to show yet.
   */
  preview(): DrawFeature | null {
    const d = this.draft;
    if (!d) return null;
    const stub = (kind: ShapeKind, coordinates: LonLat[], radiusM?: number): DrawFeature =>
      ({ id: '__draft__', kind, coordinates, ...(radiusM === undefined ? {} : { radiusM }), properties: { label: '', notes: '', color: '#ffb300' }, createdAt: '' });
    const cursor = d.cursor;
    if (d.tool === 'line') {
      const points = cursor ? [...d.points, cursor] : d.points;
      return points.length >= 2 ? stub('line', points) : null;
    }
    if (d.tool === 'polygon') {
      const points = cursor ? [...d.points, cursor] : d.points;
      if (points.length < 2) return null;
      return points.length === 2 ? stub('line', points) : stub('polygon', points);
    }
    if (!cursor || d.points.length === 0) return null;
    if (d.tool === 'rectangle') {
      const a = this.view.project(d.points[0]!), b = this.view.project(cursor);
      if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) return null;
      return stub('rectangle', screenRectangle(a, b).map((p) => this.view.unproject(p)));
    }
    const radius = groundDistanceM(d.points[0]!, cursor);
    return radius > 0 ? stub('circle', [d.points[0]!], radius) : null;
  }

  // --- clicks ---

  click(at: Pixel): void {
    if (this.swallowClick) { this.swallowClick = false; return; }
    if (!this.tool) return;
    this.notice = null;
    const place = this.view.unproject(at);
    switch (this.tool) {
      case 'select': {
        this.selected = hitTest(this.features(), at, (c) => this.view.project(c));
        break;
      }
      case 'point':
      case 'text': {
        const feature = this.store.add(this.tool === 'text'
          ? { kind: 'text', coordinates: [place], properties: { label: 'Text' } }
          : { kind: 'point', coordinates: [place] });
        this.selected = feature.id; // so its colour and label can be changed at once
        this.options.onCreate?.(feature);
        break;
      }
      case 'line':
      case 'polygon': {
        const last = this.draft?.points.at(-1);
        if (last && Math.hypot(this.view.project(last).x - at.x, this.view.project(last).y - at.y) < SAME_SPOT_PX) break; // the second click of a double-click
        this.draft = { tool: this.tool, points: [...(this.draft?.points ?? []), place], cursor: null };
        break;
      }
      case 'rectangle':
      case 'circle': {
        if (!this.draft) { this.draft = { tool: this.tool, points: [place], cursor: null }; break; }
        this.draft.cursor = place;
        this.finish();
        return;
      }
    }
    this.changed();
  }

  /** The pointer moved (not dragging): the shape being drawn follows it. */
  move(at: Pixel): void {
    if (this.drag) return this.dragTo(at);
    if (!this.draft) return;
    this.draft.cursor = this.view.unproject(at);
    this.changed();
  }

  /** A double-click: finishes a line or polygon; in select, adds a point on an edge or removes a vertex of the selected shape. */
  dblclick(at: Pixel): void {
    if (!this.tool) return;
    if (this.draft && (this.draft.tool === 'line' || this.draft.tool === 'polygon')) return this.finish();
    if (this.tool !== 'select') return;
    const f = this.selectedFeature;
    if (!f || (f.kind !== 'line' && f.kind !== 'polygon')) return;
    const project = (c: LonLat): Pixel => this.view.project(c);
    const vertex = handleAt(handlesOf(f), at, project);
    const min = f.kind === 'line' ? 2 : 3;
    if (vertex) {
      if (f.coordinates.length <= min) return this.notify(`A ${f.kind === 'line' ? 'line' : 'polygon'} needs at least ${min} points.`);
      this.store.update(f.id, { coordinates: f.coordinates.filter((_, i) => i !== vertex.index) });
      return;
    }
    const edge = edgeAt(f.coordinates as LonLat[], f.kind === 'polygon', at, project);
    if (edge) {
      const coordinates = [...f.coordinates];
      coordinates.splice(edge.after + 1, 0, this.view.unproject(edge.at));
      this.store.update(f.id, { coordinates });
    }
  }

  private notify(text: string): void {
    this.notice = text;
    this.changed();
  }

  /** Finish the shape being drawn (Enter, a double-click, or the Finish button). */
  finish(): void {
    const d = this.draft;
    if (!d) return;
    let made: DrawFeature | null = null;
    if (d.tool === 'line' || d.tool === 'polygon') {
      const need = d.tool === 'line' ? 2 : 3;
      if (d.points.length < need) return this.notify(`A ${d.tool === 'line' ? 'line' : 'polygon'} needs at least ${need} points.`);
      made = this.store.add({ kind: d.tool, coordinates: d.points });
    } else if (d.tool === 'rectangle') {
      const preview = this.preview();
      if (!preview) return this.notify('Click a second corner away from the first.');
      made = this.store.add({ kind: 'rectangle', coordinates: preview.coordinates });
    } else {
      const radius = d.cursor ? groundDistanceM(d.points[0]!, d.cursor) : 0;
      if (!(radius > 0)) return this.notify('Click a point away from the centre.');
      made = this.store.add({ kind: 'circle', coordinates: [d.points[0]!], radiusM: radius });
    }
    this.draft = null;
    this.selected = made.id;
    this.tool = 'select'; // the shape is done: select it, ready to be changed
    this.notice = null;
    this.options.onCreate?.(made);
    this.changed();
  }

  // --- dragging ---

  /** The pointer went down. Returns true when it took hold of something (a handle, or a shape), so the map must not pan. */
  press(at: Pixel): boolean {
    if (this.tool !== 'select') return false;
    const project = (c: LonLat): Pixel => this.view.project(c);
    const selected = this.selectedFeature;
    if (selected) {
      const handle = handleAt(handlesOf(selected), at, project);
      if (handle) {
        this.drag = { type: 'handle', id: selected.id, handle, started: false, from: at };
        return true;
      }
    }
    const id = hitTest(this.features(), at, project);
    if (!id) return false;
    const f = this.features().find((x) => x.id === id)!;
    this.selected = id;
    this.drag = { type: 'body', id, started: false, from: at, fromLonLat: this.view.unproject(at), original: f };
    this.changed();
    return true;
  }

  private dragTo(at: Pixel): void {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(at.x - drag.from.x, at.y - drag.from.y) < DRAG_START_PX) return;
      drag.started = true;
    }
    const f = this.store.get(drag.id);
    if (!f) return;
    const place = this.view.unproject(at);
    if (drag.type === 'body') {
      const dLon = place[0] - drag.fromLonLat[0], dLat = place[1] - drag.fromLonLat[1];
      this.dragged = { ...drag.original, coordinates: drag.original.coordinates.map(([x, y]) => [x + dLon, y + dLat] as [number, number]) };
    } else if (f.kind === 'circle') {
      this.dragged = drag.handle.role === 'centre'
        ? { ...f, coordinates: [place] }
        : { ...f, radiusM: Math.max(groundDistanceM(f.coordinates[0]!, place), 0.01) };
    } else if (f.kind === 'rectangle') {
      const corners = rectangleWithCorner(f.coordinates.map((c) => this.view.project(c as LonLat)), drag.handle.index, at);
      this.dragged = { ...f, coordinates: corners.map((p) => this.view.unproject(p)) };
    } else {
      this.dragged = { ...f, coordinates: f.coordinates.map((c, i) => (i === drag.handle.index ? place : c)) };
    }
    this.changed();
  }

  /** The pointer came up: keep what was dragged, as one step of the history. */
  release(): void {
    const drag = this.drag, dragged = this.dragged;
    this.drag = null;
    this.dragged = null;
    if (!drag) return;
    if (drag.started && dragged) {
      this.swallowClick = true; // the browser may still send a click for this press
      this.store.update(drag.id, { coordinates: dragged.coordinates, ...(dragged.radiusM === undefined ? {} : { radiusM: dragged.radiusM }) });
      return;
    }
    this.changed();
  }

  private abandonDrag(): void {
    this.drag = null;
    this.dragged = null;
  }

  // --- keys ---

  /** Escape. Returns whether it did anything: cancels the shape being drawn, else goes back to Select, else deselects. */
  cancel(): boolean {
    if (!this.tool) return false;
    if (this.drag) { this.abandonDrag(); this.changed(); return true; }
    if (this.draft) { this.draft = null; this.notice = null; this.changed(); return true; }
    if (this.tool !== 'select') { this.setTool('select'); return true; }
    if (this.selected) { this.select(null); return true; }
    return false;
  }

  /** Backspace or Delete: takes back the last point of the shape being drawn, else deletes the selected shape. Returns whether it did anything. */
  backspace(): boolean {
    if (!this.tool) return false;
    if (this.draft) {
      if (this.draft.points.length <= 1) this.draft = null;
      else this.draft.points.pop();
      this.changed();
      return true;
    }
    return this.deleteSelected();
  }

  deleteSelected(): boolean {
    if (!this.selected) return false;
    const removed = this.store.remove(this.selected);
    this.selected = null;
    this.changed();
    return removed;
  }
}
