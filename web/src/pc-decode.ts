// Turning one decoded node of a COPC file into what the map draws: only the points inside the area, each as a position relative to a
// chosen origin (in Web Mercator units, which a graphics card can hold in 32 bits without wobble at this size) and its height in feet.
// No DOM here.

import { insideGrid, type Xy } from './pc-aoi.ts';
import { Warp } from './pc-warp.ts';

/** What a decoded node offers (the COPC library's `View`, cut down to what is used). */
export interface PointView {
  pointCount: number;
  getter(name: string): (index: number) => number;
}

/** A block of points ready to draw. */
export interface Chunk {
  /** Which file of the load, and which node of it. */
  file: number;
  key: string;
  /** The Web Mercator position (0 to 1 round the world) that the positions are relative to. */
  origin: [number, number];
  /** Three numbers a point: east and south of the origin in Web Mercator units, and the height in feet. */
  positions: Float32Array;
  count: number;
  /** The lowest and highest height, in feet. */
  zMin: number;
  zMax: number;
  /** About how far apart the points are on the ground, in feet: the file's spacing halved for each level down. */
  spacingFt: number;
}

export interface Placement {
  /** The area, as grid positions. */
  ring: readonly Xy[];
  warp: Warp;
  origin: readonly [number, number];
}

/** Keep the points inside the area and place them. The order of the points is kept. */
export function chunkFromView(view: PointView, place: Placement, file: number, key: string, fileSpacingFt: number): Chunk {
  const X = view.getter('X'), Y = view.getter('Y'), Z = view.getter('Z');
  const positions = new Float32Array(view.pointCount * 3);
  const at = new Float64Array(2);
  let n = 0, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < view.pointCount; i++) {
    const x = X(i), y = Y(i);
    if (!insideGrid(place.ring, x, y)) continue;
    const z = Z(i);
    place.warp.place(x, y, at);
    positions[n * 3] = at[0]! - place.origin[0];
    positions[n * 3 + 1] = at[1]! - place.origin[1];
    positions[n * 3 + 2] = z;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    n++;
  }
  return { file, key, origin: [place.origin[0], place.origin[1]], positions: n === view.pointCount ? positions : positions.slice(0, n * 3), count: n, zMin: n ? zMin : 0, zMax: n ? zMax : 0, spacingFt: fileSpacingFt / 2 ** Number(key.split('-')[0]) };
}
