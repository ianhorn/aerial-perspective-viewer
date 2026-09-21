// Which drawn feature is under the pointer, and which of its handles: worked out on the screen (the pointer's position and the
// features projected to pixels), so "near" means a few pixels whatever the zoom. No DOM here: the caller says how to project.

import { circleRing, type LonLat } from './draw-geometry.ts';
import type { DrawFeature } from './draw-model.ts';

export interface Pixel { x: number; y: number }
export type Project = (c: LonLat) => Pixel;

/** How near, in pixels, the pointer has to be to a line or an edge to count as on it. */
export const HIT_TOLERANCE_PX = 9;
/** How near to a point or a handle. */
export const HANDLE_TOLERANCE_PX = 11;
/** The size of written text on the map, for hitting it: half a character's width, and half a line's height, in pixels. */
export const TEXT_HALF_CHAR_PX = 4;
export const TEXT_HALF_HEIGHT_PX = 12;

function distanceToSegment(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function insideRing(ring: readonly Pixel[], p: Pixel): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
function ringArea(ring: readonly Pixel[]): number {
  let twice = 0;
  ring.forEach((a, i) => { const b = ring[(i + 1) % ring.length]!; twice += a.x * b.y - b.x * a.y; });
  return Math.abs(twice) / 2;
}

/**
 * The feature under a pixel, or null. A point or text wins over a line, a line over the edge of a shape (so a line drawn along a
 * boundary can still be picked), the edge over the inside, and among insides the smallest, so a small shape drawn inside a big one
 * can still be picked. Near the edge of a shape counts as on it.
 */
export function hitTest(features: readonly DrawFeature[], at: Pixel, project: Project, tolerance = HIT_TOLERANCE_PX): string | null {
  let best: { id: string; rank: number; tie: number } | null = null;
  const consider = (id: string, rank: number, tie: number): void => {
    if (!best || rank < best.rank || (rank === best.rank && tie < best.tie)) best = { id, rank, tie };
  };
  for (const f of features) {
    if (f.kind === 'point') {
      const d = Math.hypot(project(f.coordinates[0]!).x - at.x, project(f.coordinates[0]!).y - at.y);
      if (d <= tolerance + 3) consider(f.id, 0, d);
    } else if (f.kind === 'text') {
      // The text is written centred on its place, so the hit box is the width of the writing (about 4 px a side per character).
      const p = project(f.coordinates[0]!);
      const halfWidth = Math.max(tolerance + 3, f.properties.label.length * TEXT_HALF_CHAR_PX + 4);
      if (Math.abs(p.x - at.x) <= halfWidth && Math.abs(p.y - at.y) <= TEXT_HALF_HEIGHT_PX) consider(f.id, 0, Math.hypot(p.x - at.x, p.y - at.y));
    } else if (f.kind === 'line') {
      const px = f.coordinates.map(project);
      let d = Infinity;
      for (let i = 1; i < px.length; i++) d = Math.min(d, distanceToSegment(at, px[i - 1]!, px[i]!));
      if (d <= tolerance) consider(f.id, 1, d);
    } else {
      const ring = (f.kind === 'circle' ? circleRing(f.coordinates[0]!, f.radiusM!) : f.coordinates).map(project);
      let edge = Infinity;
      for (let i = 0; i < ring.length; i++) edge = Math.min(edge, distanceToSegment(at, ring[i]!, ring[(i + 1) % ring.length]!));
      if (edge <= tolerance) consider(f.id, 2, edge);
      else if (insideRing(ring, at)) consider(f.id, 3, ringArea(ring));
    }
  }
  return (best as { id: string } | null)?.id ?? null;
}

/** A place on a feature that can be grabbed and moved. `index` is the vertex, and for a circle 0 is the centre and 1 the radius. */
export interface Handle { index: number; at: LonLat; role: 'vertex' | 'centre' | 'radius' }

/** The handles of a feature: each vertex, or for a circle its centre and a point on the edge to the east. */
export function handlesOf(f: DrawFeature): Handle[] {
  if (f.kind === 'circle') {
    const ring = circleRing(f.coordinates[0]!, f.radiusM!);
    return [{ index: 0, at: [...f.coordinates[0]!] as LonLat, role: 'centre' }, { index: 1, at: ring[0]!, role: 'radius' }];
  }
  return f.coordinates.map((c, index) => ({ index, at: [...c] as LonLat, role: 'vertex' as const }));
}

/** The handle nearest a pixel, if one is within reach. */
export function handleAt(handles: readonly Handle[], at: Pixel, project: Project, tolerance = HANDLE_TOLERANCE_PX): Handle | null {
  let best: Handle | null = null, bestD = Infinity;
  for (const h of handles) {
    const p = project(h.at);
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= tolerance && d < bestD) { best = h; bestD = d; }
  }
  return best;
}

/** The edge of a line or polygon nearest a pixel, if one is within reach: `after` is the vertex it starts at, `at` the nearest place on it. */
export function edgeAt(coordinates: readonly LonLat[], closed: boolean, at: Pixel, project: Project, tolerance = HIT_TOLERANCE_PX): { after: number; at: Pixel } | null {
  const px = coordinates.map(project);
  let best: { after: number; at: Pixel } | null = null, bestD = tolerance;
  const count = closed ? px.length : px.length - 1;
  for (let i = 0; i < count; i++) {
    const a = px[i]!, b = px[(i + 1) % px.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / len2));
    const nearest = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(at.x - nearest.x, at.y - nearest.y);
    if (d <= bestD) { best = { after: i, at: nearest }; bestD = d; }
  }
  return best;
}
