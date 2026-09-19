// Where a photo lies on the map, and which way is up. Pure geometry, no map and no browser, so it is tested
// on its own. The ground under a photo is taken as flat at one height; relief moves things sideways by about
// the height difference (tens of feet in most of Kentucky), which the terrain patches could correct later.

import type { Camera } from './camera.ts';
import { gridToLonLat } from './lcc.ts';

export type LngLat = [number, number];

/** The mean height of the four corners of a footprint, `[x, y, z]` in grid feet. Used as the height of the flat ground. */
export function meanGroundHeight(footprint: readonly (readonly number[])[]): number {
  const corners = footprint.slice(0, 4);
  return corners.reduce((sum, p) => sum + p[2]!, 0) / corners.length;
}

function lonLatAt(camera: Camera, col: number, row: number, z: number): LngLat | null {
  const ground = camera.pixelToGround(col, row, z);
  return ground && gridToLonLat(ground[0], ground[1]);
}

/**
 * The four corners of the photo on the ground, as MapLibre wants them for an image: top-left, top-right,
 * bottom-right, bottom-left of the picture. Null when a corner's ray never reaches the ground, which would
 * happen for a photo that shows the horizon.
 */
export function photoCorners(camera: Camera, z: number): [LngLat, LngLat, LngLat, LngLat] | null {
  const { widthPx: w, heightPx: h } = camera;
  const corners = [lonLatAt(camera, 0, 0, z), lonLatAt(camera, w, 0, z), lonLatAt(camera, w, h, z), lonLatAt(camera, 0, h, z)];
  return corners.every((c) => c !== null) ? (corners as [LngLat, LngLat, LngLat, LngLat]) : null;
}

/** The compass bearing (degrees clockwise from true north, 0 to 360) from one point to another. */
export function bearingBetween(from: LngLat, to: LngLat): number {
  const rad = Math.PI / 180;
  const dLon = (to[0] - from[0]) * rad;
  const lat1 = from[1] * rad;
  const lat2 = to[1] * rad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/**
 * The map bearing that puts the top of the photo at the top of the screen: the true bearing from the middle
 * of the picture's bottom edge to the middle of its top edge, on the ground. For an oblique that is the way
 * the camera looks, as a true bearing (the vendor's look azimuth is a grid bearing, which can differ by up to
 * about 3 degrees in Kentucky).
 */
export function upBearing(camera: Camera, z: number): number | null {
  const bottom = lonLatAt(camera, camera.widthPx / 2, camera.heightPx, z);
  const top = lonLatAt(camera, camera.widthPx / 2, 0, z);
  return bottom && top ? bearingBetween(bottom, top) : null;
}
