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

// How each oblique camera looks relative to the direction the aircraft flies, clockwise in compass degrees
// (from The heading problem in CLAUDE.md: Fwd ahead, Bwd behind, Left 90 degrees to the left, Right to the right).
const LOOK_OFFSET: Record<string, number> = { Fwd: 0, Bwd: 180, Left: -90, Right: 90 };

/**
 * The direction the aircraft was flying, as a grid bearing in degrees (0 to 360), or null when it is not known.
 * For an oblique it is the look direction minus the camera's offset. The Color camera has no look direction,
 * so its own ground-track heading is used when there is one.
 */
export function flightHeading(camera: string, lookAzimuth: number | null, trackHeading: number | null = null): number | null {
  const offset = LOOK_OFFSET[camera];
  if (offset !== undefined && lookAzimuth !== null) return (((lookAzimuth - offset) % 360) + 360) % 360;
  return trackHeading;
}

/**
 * A grid bearing (clockwise from grid north, at grid position x, y in feet) as a true bearing, which is what a
 * map turned to true north uses. They differ by the grid convergence, up to about 2.4 degrees in Kentucky.
 */
export function gridBearingToTrue(x: number, y: number, gridBearing: number): number {
  const b = (gridBearing * Math.PI) / 180;
  const step = 1000; // feet; far enough that rounding does not matter, near enough that the curve does not
  return bearingBetween(gridToLonLat(x, y), gridToLonLat(x + step * Math.sin(b), y + step * Math.cos(b)));
}

/**
 * The ground height at a grid position from a footprint's corners (`[x, y, z]`), by the plane that best fits them.
 * A stand-in for the terrain patch: on the ten real photos the corners' own heights were off the patch by about
 * 15 ft, and a plane through them cannot follow bumps, so it is only good to some tens of feet.
 */
export function planeHeightAt(footprint: readonly (readonly number[])[], x: number, y: number): number {
  const pts = footprint.slice(0, 4);
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0]!, 0) / n, my = pts.reduce((s, p) => s + p[1]!, 0) / n, mz = pts.reduce((s, p) => s + p[2]!, 0) / n;
  // z - mz = a (x - mx) + b (y - my), least squares: solve the 2 x 2 normal equations.
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  for (const p of pts) {
    const dx = p[0]! - mx, dy = p[1]! - my, dz = p[2]! - mz;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxz += dx * dz; syz += dy * dz;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return mz;
  const a = (sxz * syy - syz * sxy) / det, b = (syz * sxx - sxz * sxy) / det;
  return mz + a * (x - mx) + b * (y - my);
}

/**
 * Where the ray through a pixel of a photo meets the ground, when the ground is not flat: `heightAt` gives the ground
 * height (feet) at a grid position. The ray is met with a horizontal plane at some height; the right height is the one
 * where the ground under that place is exactly that high, found by bisection. `around` is a rough ground height to
 * search about, `span` how far above and below it to look. Null when the ray never reaches the ground within that range.
 */
export function groundAtPixel(
  camera: Camera, col: number, row: number, heightAt: (x: number, y: number) => number, around: number, span = 2000,
): { x: number; y: number; z: number } | null {
  // How far the ground under the ray's place at height z lies above that height: positive when the ray is still below the ground.
  const sample = (z: number): { x: number; y: number; over: number } | null => {
    const g = camera.pixelToGround(col, row, z);
    return g ? { x: g[0], y: g[1], over: heightAt(g[0], g[1]) - z } : null;
  };
  let lo = around - span, hi = Math.min(around + span, camera.position[2] - 1);
  const atLo = sample(lo), atHi = sample(hi);
  if (!atLo || !atHi || atLo.over < 0 || atHi.over > 0) return null;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const at = sample(mid);
    if (!at) return null;
    if (at.over > 0) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  const at = sample(z);
  return at && { x: at.x, y: at.y, z };
}
