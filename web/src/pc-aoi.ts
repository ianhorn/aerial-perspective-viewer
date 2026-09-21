// The area a point cloud is loaded for: a polygon (four corners for a drawn rectangle, or for the view), its size, and the limit on how
// big it may be. Positions are [longitude, latitude]; sizes are worked out on the Kentucky State Plane grid (EPSG:3089, US survey feet),
// where the point clouds are. No DOM here.

import { gridToLonLat, lonLatToGrid } from './lcc.ts';
import { polygonArea } from './measure.ts';

export type LonLat = [number, number];
export type Xy = [number, number];

export const SQ_FT_PER_SQ_MI = 5280 ** 2; // survey and international miles differ by 2 ppm; nothing here needs that
/** The most a single load may cover. About four of the state's 5,000 ft tiles (a tile is 0.9 square miles), so a load reads a handful of files. */
export const MAX_AOI_SQ_MI = 4;

export const gridRing = (ring: readonly LonLat[]): Xy[] => ring.map(([lon, lat]) => lonLatToGrid(lon, lat));

/** The area of a polygon of places in square miles. */
export function areaSqMi(ring: readonly LonLat[]): number {
  return polygonArea(gridRing(ring).map(([x, y]) => ({ x, y, z: 0 }))) / SQ_FT_PER_SQ_MI;
}

/** The smallest grid rectangle round a polygon: [xmin, ymin, xmax, ymax] in feet. */
export function gridBox(ring: readonly LonLat[]): [number, number, number, number] {
  const g = gridRing(ring);
  return [Math.min(...g.map((p) => p[0])), Math.min(...g.map((p) => p[1])), Math.max(...g.map((p) => p[0])), Math.max(...g.map((p) => p[1]))];
}

/** Whether a grid position is inside a polygon of grid positions (even-odd; on the edge either way). */
export function insideGrid(ring: readonly Xy[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/**
 * The polygon shrunk about its middle, if it is bigger than the limit, until it is exactly the limit. Shrinking is done on the grid, so a
 * rotated or slightly slanted polygon keeps its shape. Returns the polygon and whether it had to be shrunk.
 */
export function withinLimit(ring: readonly LonLat[], maxSqMi = MAX_AOI_SQ_MI): { ring: LonLat[]; limited: boolean } {
  const area = areaSqMi(ring);
  if (area <= maxSqMi) return { ring: ring.map((p) => [...p] as LonLat), limited: false };
  const g = gridRing(ring);
  const cx = g.reduce((s, p) => s + p[0], 0) / g.length, cy = g.reduce((s, p) => s + p[1], 0) / g.length;
  const f = Math.sqrt(maxSqMi / area);
  return { ring: g.map(([x, y]) => gridToLonLat(cx + (x - cx) * f, cy + (y - cy) * f)), limited: true };
}

/** The polygon as a GeoJSON polygon geometry (closed ring, longitude then latitude), for a STAC search. */
export function toGeoJsonPolygon(ring: readonly LonLat[]): { type: 'Polygon'; coordinates: LonLat[][] } {
  const closed = ring.map((p) => [...p] as LonLat);
  closed.push([...ring[0]!] as LonLat);
  return { type: 'Polygon', coordinates: [closed] };
}
