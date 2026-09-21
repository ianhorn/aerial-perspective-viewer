// What the user has drawn: a list of features (points, lines, polygons, rectangles, circles and text), with an undo and redo
// history, kept as plain data so it can be shown on the map, saved in the browser and exported. No DOM here.
//
// Positions are [longitude, latitude] in degrees (WGS84; the difference from NAD83 is about a metre and is ignored, as it is
// everywhere in this app). A shape is stored as the few numbers that define it, not as the polygon it turns into: a circle is a
// centre and a radius, a rectangle its four corners. `draw-geometry.ts` makes the geometry.

export type ShapeKind = 'point' | 'line' | 'polygon' | 'rectangle' | 'circle' | 'text';

export interface DrawProperties {
  /** A name or caption. It is shown beside the feature on the map, and for a text feature it is the text itself. */
  label: string;
  notes: string;
  /** A colour as #rrggbb. */
  color: string;
}

export interface DrawFeature {
  id: string;
  kind: ShapeKind;
  /**
   * The vertices, [lon, lat]. A point or text: one. A line: two or more. A polygon: three or more, not repeating the first (the
   * ring closes itself). A rectangle: its four corners in order. A circle: the centre only, with `radiusM`.
   */
  coordinates: [number, number][];
  /** For a circle, the radius in metres. */
  radiusM?: number;
  properties: DrawProperties;
  /** When it was made, as an ISO time. */
  createdAt: string;
}

/** What is needed to make a feature; the store gives it an id and a time. */
export type NewFeature = Omit<DrawFeature, 'id' | 'createdAt' | 'properties'> & { properties?: Partial<DrawProperties> };

/** The colours offered, in the order shown. */
export const COLOURS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ffffff', '#212121'] as const;
export const DEFAULT_COLOUR = '#e53935';

const MIN_VERTICES: Record<ShapeKind, number> = { point: 1, text: 1, line: 2, polygon: 3, rectangle: 4, circle: 1 };
const MAX_VERTICES: Record<ShapeKind, number> = { point: 1, text: 1, line: 100_000, polygon: 100_000, rectangle: 4, circle: 1 };

/** Why a feature cannot be used, or null when it can. Used on what is loaded from storage as well as on what is drawn. */
export function problemWith(f: unknown): string | null {
  if (typeof f !== 'object' || f === null) return 'not an object';
  const x = f as Partial<DrawFeature>;
  if (typeof x.id !== 'string' || x.id === '') return 'no id';
  if (!x.kind || !(x.kind in MIN_VERTICES)) return `unknown kind ${String(x.kind)}`;
  if (!Array.isArray(x.coordinates)) return 'no coordinates';
  if (x.coordinates.length < MIN_VERTICES[x.kind] || x.coordinates.length > MAX_VERTICES[x.kind]) return `a ${x.kind} cannot have ${x.coordinates.length} vertices`;
  for (const c of x.coordinates) {
    if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return 'a vertex is not a pair of numbers';
    if (Math.abs(c[0]!) > 180 || Math.abs(c[1]!) > 90) return 'a vertex is outside the world';
  }
  if (x.kind === 'circle' && !(typeof x.radiusM === 'number' && x.radiusM > 0 && Number.isFinite(x.radiusM))) return 'a circle needs a radius above zero';
  if (typeof x.properties !== 'object' || x.properties === null) return 'no properties';
  return null;
}

/** A feature as loaded (maybe from an older save), with anything missing filled in; null when it is not usable. */
export function repair(raw: unknown): DrawFeature | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const p = (typeof r['properties'] === 'object' && r['properties'] !== null ? r['properties'] : {}) as Record<string, unknown>;
  const feature = {
    ...r,
    properties: {
      label: typeof p['label'] === 'string' ? p['label'] : '',
      notes: typeof p['notes'] === 'string' ? p['notes'] : '',
      color: typeof p['color'] === 'string' && /^#[0-9a-f]{6}$/i.test(p['color']) ? p['color'] : DEFAULT_COLOUR,
    },
    createdAt: typeof r['createdAt'] === 'string' ? r['createdAt'] : new Date(0).toISOString(),
  };
  return problemWith(feature) === null ? (feature as unknown as DrawFeature) : null;
}

const HISTORY_LIMIT = 100;
let counter = 0;
const newId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `f${Date.now().toString(36)}${(counter++).toString(36)}`);
const copy = (list: readonly DrawFeature[]): DrawFeature[] => list.map((f) => ({ ...f, coordinates: f.coordinates.map((c) => [...c] as [number, number]), properties: { ...f.properties } }));

export class DrawStore {
  private list: DrawFeature[] = [];
  private undoStack: DrawFeature[][] = [];
  private redoStack: DrawFeature[][] = [];
  private readonly listeners = new Set<() => void>();
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  get features(): readonly DrawFeature[] {
    return this.list;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get(id: string): DrawFeature | undefined {
    return this.list.find((f) => f.id === id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  /** Remember the list as it is, before a change, so the change can be undone. Anything that was undone can no longer be redone. */
  private remember(): void {
    this.undoStack.push(copy(this.list));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  add(input: NewFeature): DrawFeature {
    const feature: DrawFeature = {
      ...input,
      id: newId(),
      createdAt: this.clock(),
      properties: { label: '', notes: '', color: DEFAULT_COLOUR, ...input.properties },
    };
    const problem = problemWith(feature);
    if (problem) throw new Error(`cannot add that feature: ${problem}`);
    this.remember();
    this.list.push(feature);
    this.changed();
    return feature;
  }

  /** Change a feature's vertices, radius or properties. Each call is one step of the history. */
  update(id: string, patch: { coordinates?: [number, number][]; radiusM?: number; kind?: ShapeKind; properties?: Partial<DrawProperties> }): boolean {
    const at = this.list.findIndex((f) => f.id === id);
    if (at < 0) return false;
    const current = this.list[at]!;
    const next: DrawFeature = {
      ...current,
      ...(patch.coordinates ? { coordinates: patch.coordinates.map((c) => [...c] as [number, number]) } : {}),
      ...(patch.radiusM !== undefined ? { radiusM: patch.radiusM } : {}),
      ...(patch.kind ? { kind: patch.kind } : {}),
      properties: { ...current.properties, ...patch.properties },
    };
    const problem = problemWith(next);
    if (problem) throw new Error(`cannot change that feature: ${problem}`);
    this.remember();
    this.list[at] = next;
    this.changed();
    return true;
  }

  remove(id: string): boolean {
    const at = this.list.findIndex((f) => f.id === id);
    if (at < 0) return false;
    this.remember();
    this.list.splice(at, 1);
    this.changed();
    return true;
  }

  /** Remove everything (one step of the history, so it can be undone). */
  clear(): void {
    if (this.list.length === 0) return;
    this.remember();
    this.list = [];
    this.changed();
  }

  /** Put a list in place of the current one, as when loading: the history starts again, and features that are not usable are left out. */
  load(features: readonly unknown[]): number {
    const usable = features.map(repair).filter((f): f is DrawFeature => f !== null);
    this.list = usable;
    this.undoStack = [];
    this.redoStack = [];
    this.changed();
    return usable.length;
  }

  undo(): boolean {
    const before = this.undoStack.pop();
    if (!before) return false;
    this.redoStack.push(copy(this.list));
    this.list = before;
    this.changed();
    return true;
  }

  redo(): boolean {
    const after = this.redoStack.pop();
    if (!after) return false;
    this.undoStack.push(copy(this.list));
    this.list = after;
    this.changed();
    return true;
  }
}
