// The shapes behind the drawing features: the geometry a feature stands for (a circle is a ring of points, a rectangle a polygon), how
// big it is, and where its label goes. Sizes are worked out on the Kentucky State Plane grid (EPSG:3089, US survey feet), the same
// as the measuring tools, which is accurate to about 0.01% across the state, and circles are drawn in that grid too (a planar circle
// in State Plane feet, as in ArcGIS). No DOM here.

import type { DrawFeature } from './draw-model.ts';
import { gridToLonLat, lonLatToGrid } from './lcc.ts';
import { METRES_PER_FOOT, pathLength, perimeter, polygonArea, type Ground } from './measure.ts';

/** How many sides a circle is drawn with. */
export const CIRCLE_SEGMENTS = 64;

export type LonLat = [number, number];
export type Geometry =
  | { type: 'Point'; coordinates: LonLat }
  | { type: 'LineString'; coordinates: LonLat[] }
  | { type: 'Polygon'; coordinates: LonLat[][] };

const toGround = (c: LonLat): Ground => {
  const [x, y] = lonLatToGrid(c[0], c[1]);
  return { x, y, z: 0 };
};

/** The ring of points a circle is drawn as (closed: the first point is repeated at the end), on the State Plane grid. */
export function circleRing(centre: LonLat, radiusM: number, segments = CIRCLE_SEGMENTS): LonLat[] {
  const [cx, cy] = lonLatToGrid(centre[0], centre[1]);
  const radiusFt = radiusM / METRES_PER_FOOT;
  const ring: LonLat[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    ring.push(gridToLonLat(cx + radiusFt * Math.cos(angle), cy + radiusFt * Math.sin(angle)));
  }
  ring.push([...ring[0]!]);
  return ring;
}

/** The corners, in order, of the rectangle that has two opposite corners on the screen (the drawing is on a map that may be turned, so it is made in screen pixels). */
export function screenRectangle(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number }[] {
  return [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
}

/** The closed ring of a polygon-like feature: a polygon, a rectangle or a circle. */
export function ringOf(f: DrawFeature): LonLat[] {
  if (f.kind === 'circle') return circleRing(f.coordinates[0]!, f.radiusM!);
  const ring = f.coordinates.map((c) => [...c] as LonLat);
  ring.push([...ring[0]!]);
  return ring;
}

/** The GeoJSON geometry a feature is exported as. A text feature is a point. */
export function geometryOf(f: DrawFeature): Geometry {
  switch (f.kind) {
    case 'point':
    case 'text':
      return { type: 'Point', coordinates: [...f.coordinates[0]!] as LonLat };
    case 'line':
      return { type: 'LineString', coordinates: f.coordinates.map((c) => [...c] as LonLat) };
    default:
      return { type: 'Polygon', coordinates: [ringOf(f)] };
  }
}

export interface Measures {
  /** The length of a line. */
  lengthFt?: number;
  /** The distance round a polygon, rectangle or circle. */
  perimeterFt?: number;
  areaSqFt?: number;
  radiusFt?: number;
}

/** How big a feature is, in feet and square feet (a circle's area is exactly pi r squared, not the area of the ring that draws it). */
export function measuresOf(f: DrawFeature): Measures {
  switch (f.kind) {
    case 'line':
      return { lengthFt: pathLength(f.coordinates.map(toGround), '2d') };
    case 'polygon':
    case 'rectangle': {
      const ground = f.coordinates.map(toGround);
      return { perimeterFt: perimeter(ground), areaSqFt: polygonArea(ground) };
    }
    case 'circle': {
      const r = f.radiusM! / METRES_PER_FOOT;
      return { radiusFt: r, perimeterFt: 2 * Math.PI * r, areaSqFt: Math.PI * r * r };
    }
    default:
      return {};
  }
}

/** Whether a place is inside a polygon (even-odd), in any flat coordinates. */
function inside(ring: readonly { x: number; y: number }[], p: { x: number; y: number }): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Where a feature's label goes: on a point or the centre of a circle; the middle, along its length, of a line; the middle of a polygon (its centre of mass, or where there is most room if that falls outside it). */
export function labelPoint(f: DrawFeature): LonLat {
  if (f.kind === 'point' || f.kind === 'text' || f.kind === 'circle') return [...f.coordinates[0]!] as LonLat;
  const ground = f.coordinates.map(toGround);
  if (f.kind === 'line') {
    const half = pathLength(ground, '2d') / 2;
    let walked = 0;
    for (let i = 1; i < ground.length; i++) {
      const a = ground[i - 1]!, b = ground[i]!;
      const step = Math.hypot(b.x - a.x, b.y - a.y);
      if (walked + step >= half && step > 0) {
        const t = (half - walked) / step;
        return gridToLonLat(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      }
      walked += step;
    }
    return [...f.coordinates[0]!] as LonLat;
  }
  // The centre of mass of the polygon; if it falls outside (a crescent or an L), the average of the vertices, then a vertex.
  let twice = 0, cx = 0, cy = 0;
  ground.forEach((a, i) => {
    const b = ground[(i + 1) % ground.length]!;
    const cross = a.x * b.y - b.x * a.y;
    twice += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  });
  if (Math.abs(twice) > 1e-9) {
    const centre = { x: cx / (3 * twice), y: cy / (3 * twice) };
    if (inside(ground, centre)) return gridToLonLat(centre.x, centre.y);
  }
  const roomiest = roomiestPoint(ground);
  return roomiest ? gridToLonLat(roomiest.x, roomiest.y) : ([...f.coordinates[0]!] as LonLat);
}

/** How far a place is from the nearest edge of a ring, in the ring's own units. */
function distanceToEdge(ring: readonly { x: number; y: number }[], p: { x: number; y: number }): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * The point inside a polygon that is farthest from its edges (a good place for a label in a crescent or an L), found by looking on a
 * grid over the polygon and then again on finer grids round the best place so far. Null when no grid point is inside.
 */
function roomiestPoint(ring: readonly { x: number; y: number }[]): { x: number; y: number } | null {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let best: { x: number; y: number } | null = null, bestDistance = -1;
  for (let round = 0; round < 6; round++) {
    const n = 24;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const p = { x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * j) / n };
        if (!inside(ring, p)) continue;
        const d = distanceToEdge(ring, p);
        if (d > bestDistance) { best = p; bestDistance = d; }
      }
    }
    if (!best) return null;
    const halfX = (x1 - x0) / 6, halfY = (y1 - y0) / 6; // the next look is at a third of the size, round the best place
    x0 = best.x - halfX; x1 = best.x + halfX; y0 = best.y - halfY; y1 = best.y + halfY;
  }
  return best;
}

/** West, south, east, north of a feature, in degrees. */
export function boundsOf(f: DrawFeature): [number, number, number, number] {
  const points = f.kind === 'circle' ? circleRing(f.coordinates[0]!, f.radiusM!) : f.coordinates;
  const lons = points.map((c) => c[0]), lats = points.map((c) => c[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** The distance in metres between two places, on the State Plane grid (as the sizes are). Used for a circle's radius. */
export function groundDistanceM(a: LonLat, b: LonLat): number {
  const p = toGround(a), q = toGround(b);
  return Math.hypot(q.x - p.x, q.y - p.y) * METRES_PER_FOOT;
}

/**
 * A rectangle (four corners in order, on the screen) with one corner dragged to `to`: the opposite corner stays where it is and
 * the sides keep their directions, so the shape stays a rectangle even if it is turned on the screen. The dragged corner is the
 * point of the rectangle's frame nearest `to`. A rectangle with no size in either direction is returned as it is.
 */
export function rectangleWithCorner(corners: readonly { x: number; y: number }[], index: number, to: { x: number; y: number }): { x: number; y: number }[] {
  const opposite = (index + 2) % 4, next = (opposite + 1) % 4, previous = (opposite + 3) % 4;
  const o = corners[opposite]!;
  const ax = corners[next]!.x - o.x, ay = corners[next]!.y - o.y;
  const bx = corners[previous]!.x - o.x, by = corners[previous]!.y - o.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return corners.map((c) => ({ ...c }));
  const s = ((to.x - o.x) * ax + (to.y - o.y) * ay) / la;
  const t = ((to.x - o.x) * bx + (to.y - o.y) * by) / lb;
  const out = corners.map((c) => ({ ...c }));
  out[next] = { x: o.x + (ax / la) * s, y: o.y + (ay / la) * s };
  out[previous] = { x: o.x + (bx / lb) * t, y: o.y + (by / lb) * t };
  out[index] = { x: o.x + (ax / la) * s + (bx / lb) * t, y: o.y + (ay / la) * s + (by / lb) * t };
  return out;
}
