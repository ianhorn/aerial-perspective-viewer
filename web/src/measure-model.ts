// What the user is measuring: which tool is on and the points picked so far, kept as ground points (EPSG:3089
// feet) and not as places in one picture, so the photo pane and the scene can both show and extend the same
// measurement. This file holds no DOM; the buttons are in `measure-ui.ts`, the drawing in `measure-shape.ts`.

import { gridToLonLat } from './lcc.ts';
import {
  crossesItself, distance2d, distance3d, formatArea, formatLength, formatPercent, formatRise, pathLength, perimeter, polygonArea, surfaceArea,
  type Ground, type HeightAt,
} from './measure.ts';

export type ToolId = 'distance' | 'distance3d' | 'area' | 'area3d' | 'height' | 'surface' | 'location3d';

export interface ToolInfo {
  id: ToolId;
  label: string;
  /** What to do next, as the tool is chosen (before any point is picked). */
  hint: string;
}

/** The tools, in the order the buttons show them. */
export const TOOLS: readonly ToolInfo[] = [
  { id: 'distance', label: 'Distance', hint: 'Click points along the ground to measure the level distance.' },
  { id: 'distance3d', label: 'Distance 3D', hint: 'Click points along the ground to measure the distance along the slope.' },
  { id: 'area', label: 'Area', hint: 'Click the corners of the area on the ground.' },
  { id: 'area3d', label: 'Area 3D', hint: 'Click the corners of the area to measure the surface of the ground, slopes included.' },
  { id: 'height', label: 'Height', hint: 'Click the bottom of the thing on the ground, then its top.' },
  { id: 'surface', label: 'Surface location', hint: 'Click a spot on the ground to read where it is.' },
  { id: 'location3d', label: 'Location 3D', hint: 'Click the ground under a point, then the point itself, to read where it is in the air.' },
];

/** A picked ground point, and the photo it was picked in. */
export interface Vertex extends Ground {
  frame: string;
  /** True when the photo had no elevation patch and the ground height is a plane through its footprint (good to some tens of feet). */
  approximate?: boolean;
}

export interface Reading {
  /** What to do next, or what the numbers are, in one line. */
  prompt: string;
  /** The numbers. The first row is the answer. */
  rows: { label: string; value: string }[];
  warnings: string[];
}

const isAreaTool = (tool: ToolId): boolean => tool === 'area' || tool === 'area3d';
/** The tools that pick a ground point and then a point above it. */
export const isHeightTool = (tool: ToolId | null): boolean => tool === 'height' || tool === 'location3d';

/** A picked height's ceiling: taller than this and the click was probably not straight above the base. */
const OFF_LINE_PX = 12;

export class MeasureModel {
  tool: ToolId | null = null;
  vertices: Vertex[] = [];
  /** For the height tools: how high above the first vertex the second point is, once it has been picked. */
  rise: number | null = null;
  /** How far, in photo pixels, the click for the top was from the vertical line above the base. */
  offPx = 0;
  /** The ground height in feet at a grid position, from the photo the latest point was picked in. Needed for the surface area. */
  heightAt: HeightAt | null = null;
  /** Why the last click did nothing (it was above the horizon, or outside the photo), until the next one that works. */
  notice: string | null = null;
  private readonly listeners = new Set<() => void>();
  private version = 0; // counts the changes, so what is worked out from the points can be kept until they change
  private areaKept: { version: number; value: number } | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  get active(): boolean {
    return this.tool !== null;
  }

  /** Turn a tool on (clearing what was measured) or, with null or the tool already on, turn the tools off. */
  setTool(tool: ToolId | null): void {
    this.tool = tool === this.tool ? null : tool;
    this.vertices = [];
    this.rise = null;
    this.offPx = 0;
    this.notice = null;
    this.changed();
  }

  /** Say why the last click did nothing, or take the message off with null. */
  setNotice(notice: string | null): void {
    if (notice === this.notice) return;
    this.notice = notice;
    this.changed();
  }

  /** Whether the next click is the top of the thing, for the height tools. */
  get needsTop(): boolean {
    return isHeightTool(this.tool) && this.vertices.length === 1 && this.rise === null;
  }

  /** Add a picked ground point. The single-point tools replace their point, and a finished height starts again. */
  addVertex(vertex: Vertex, heightAt: HeightAt | null = this.heightAt): void {
    if (!this.tool) return;
    if (this.tool === 'surface' || (isHeightTool(this.tool) && (this.vertices.length >= 1))) this.vertices = [];
    if (isHeightTool(this.tool)) this.rise = null;
    this.vertices.push(vertex);
    this.heightAt = heightAt;
    this.notice = null;
    this.changed();
  }

  /** Set the height of the top point above the first vertex. */
  setRise(rise: number, offPx: number): void {
    if (!this.needsTop) return;
    this.rise = rise;
    this.offPx = offPx;
    this.notice = null;
    this.changed();
  }

  /** Take back the last point. */
  undo(): void {
    if (this.rise !== null) this.rise = null;
    else this.vertices.pop();
    this.notice = null;
    this.changed();
  }

  clear(): void {
    if (this.vertices.length === 0 && this.rise === null && this.notice === null) return;
    this.vertices = [];
    this.rise = null;
    this.offPx = 0;
    this.notice = null;
    this.changed();
  }

  /**
   * The area of the outline picked so far, in square feet: seen from above for the Area tool, along the ground's surface
   * for Area 3D. Kept until the points change, since the surface takes a few thousand terrain lookups and a drawing asks
   * for it every frame.
   */
  get area(): number {
    if (this.areaKept?.version === this.version) return this.areaKept.value;
    const flat = polygonArea(this.vertices);
    const value = this.tool === 'area3d' && this.heightAt && this.vertices.length >= 3 ? surfaceArea(this.vertices, this.heightAt) : flat;
    this.areaKept = { version: this.version, value };
    return value;
  }

  get isEmpty(): boolean {
    return this.vertices.length === 0 && this.rise === null;
  }

  /** The point in the air, for the height tools once the top has been picked. */
  get top(): (Ground & { frame: string }) | null {
    const base = this.vertices[0];
    return base && this.rise !== null ? { x: base.x, y: base.y, z: base.z + this.rise, frame: base.frame } : null;
  }

  /** The words and numbers for what has been picked so far. */
  reading(): Reading | null {
    const tool = this.tool;
    if (!tool) return null;
    const info = TOOLS.find((t) => t.id === tool)!;
    const v = this.vertices;
    const rows: Reading['rows'] = [];
    const warnings: string[] = [];
    let prompt = info.hint;

    if (this.notice) warnings.push(this.notice);
    if (v.some((p) => p.approximate)) warnings.push('One photo had no elevation patch, so its ground height is only roughly right.');

    if (tool === 'distance' || tool === 'distance3d') {
      if (v.length === 1) prompt = 'Click the next point.';
      if (v.length >= 2) {
        const flat = pathLength(v, '2d'), slope = pathLength(v, '3d');
        const first = v[0]!, last = v[v.length - 1]!;
        prompt = v.length === 2 ? 'Click another point to carry on, or start again with Clear.' : `${v.length} points. Click to add more.`;
        rows.push(tool === 'distance' ? { label: 'Distance', value: formatLength(flat) } : { label: 'Distance 3D', value: formatLength(slope) });
        rows.push(tool === 'distance' ? { label: 'Along the slope', value: formatLength(slope) } : { label: 'Level distance', value: formatLength(flat) });
        rows.push({ label: 'Elevation change', value: `${formatRise(last.z - first.z)} from first to last point` });
        if (v.length === 2 && flat > 0) rows.push({ label: 'Slope', value: formatPercent(Math.abs(last.z - first.z) / flat) });
      }
    } else if (isAreaTool(tool)) {
      if (v.length === 1) prompt = 'Click the next corner.';
      if (v.length === 2) prompt = 'Click a third corner to make an area.';
      if (v.length >= 3) {
        const flat = polygonArea(v);
        prompt = `${v.length} corners. Click to add more.`;
        if (tool === 'area') {
          rows.push({ label: 'Area', value: formatArea(flat) });
          rows.push({ label: 'Perimeter', value: formatLength(perimeter(v)) });
        } else {
          const surface = this.area;
          rows.push({ label: 'Surface area', value: formatArea(surface) });
          rows.push({ label: 'Flat area', value: formatArea(flat) });
          rows.push({ label: 'Steeper by', value: formatPercent(flat > 0 ? surface / flat - 1 : 0) });
        }
        if (crossesItself(v)) warnings.push('The outline crosses itself, so the area is not the area it encloses. Undo the last corner or start again.');
      }
    } else if (tool === 'surface') {
      const p = v[0];
      if (p) {
        const [lon, lat] = gridToLonLat(p.x, p.y);
        prompt = 'Click another spot to read it.';
        rows.push({ label: 'Latitude, longitude', value: `${lat.toFixed(6)}, ${lon.toFixed(6)}` });
        rows.push({ label: 'Ground elevation', value: formatLength(p.z) });
        rows.push({ label: 'State Plane (EPSG:3089)', value: `${Math.round(p.x).toLocaleString('en-US')} E, ${Math.round(p.y).toLocaleString('en-US')} N ft` });
      }
    } else if (isHeightTool(tool)) {
      const base = v[0];
      if (base && this.rise === null) prompt = 'Now click the top of it, straight above the first point.';
      if (base && this.rise !== null) {
        prompt = 'Click again to measure something else.';
        const top = this.top!;
        if (tool === 'height') {
          rows.push({ label: 'Height', value: formatLength(this.rise) });
          rows.push({ label: 'Ground elevation', value: formatLength(base.z) });
          rows.push({ label: 'Top elevation', value: formatLength(top.z) });
        } else {
          const [lon, lat] = gridToLonLat(top.x, top.y);
          rows.push({ label: 'Latitude, longitude', value: `${lat.toFixed(6)}, ${lon.toFixed(6)}` });
            rows.push({ label: 'Elevation', value: formatLength(top.z) });
          rows.push({ label: 'Height above ground', value: formatLength(this.rise) });
          rows.push({ label: 'State Plane (EPSG:3089)', value: `${Math.round(top.x).toLocaleString('en-US')} E, ${Math.round(top.y).toLocaleString('en-US')} N ft` });
        }
        if (this.offPx > OFF_LINE_PX) warnings.push(`The top was ${Math.round(this.offPx)} px to the side of the line straight up from the first point. Click straight above it for a truer height.`);
        if (this.rise < 0) warnings.push('The second point is below the ground under the first.');
      }
    }
    return { prompt, rows, warnings };
  }
}

/** The straight-line lengths of each side, for labels on a drawing: [from, to, length in feet]. */
export function sides(points: readonly Ground[], mode: '2d' | '3d', closed = false): { a: Ground; b: Ground; feet: number }[] {
  const step = mode === '2d' ? distance2d : distance3d;
  const out: { a: Ground; b: Ground; feet: number }[] = [];
  const n = closed && points.length >= 3 ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    out.push({ a, b, feet: step(a, b) });
  }
  return out;
}
