// The maths behind the measuring tools. A photo is not orthorectified, so a click on it is a ray, not a place. The ray
// is turned into a place by meeting it with the ground (the photo's own elevation patch, see `terrain.ts`), and a
// point above the ground (the top of a building or a tree) by asking how high above a known ground point it must be to
// land where the user clicked.
//
// Everything is in EPSG:3089 (Kentucky Single Zone) US survey feet: x east, y north, z up. On the grid, lengths are
// off from true ground lengths by the grid's scale factor, which is within about 0.01% (1 ft in 10,000 ft) in the
// state, well under the imagery's own 0.67 ft accuracy, so it is not corrected.
//
// What limits the accuracy: the ground is bare earth on 50 ft cells (the patch agrees with the statewide DEM to
// 0.5 to 1.7 ft on the frames compared), and a ground height error of dz moves a point sideways by about 1 to 1.5 dz
// in an oblique view, so on steep or rough ground a distance can be off by several feet. Buildings and trees are not
// in the terrain: a point picked on a roof is a point on the ground behind the roof's image, so the height tools
// exist for those.

import type { Camera } from './camera.ts';
import { groundAtPixel } from './scene.ts';

/** A place in the grid, in feet. */
export interface Ground { x: number; y: number; z: number }
/** The ground height in feet at a grid position. */
export type HeightAt = (x: number, y: number) => number;

/** Feet (US survey) in a metre: the survey foot is exactly 1200/3937 m. */
export const METRES_PER_FOOT = 1200 / 3937;
export const SQUARE_FEET_PER_ACRE = 43560;
const FEET_PER_MILE = 5280;

/**
 * The ground point seen at a pixel of the full-size photo: where its ray meets the ground. `around` is a rough
 * ground height to search about (the mean height of the photo's footprint will do). Null when the ray misses the
 * ground, for a pixel above the horizon or too far from `around`.
 */
export function surfacePoint(camera: Camera, col: number, row: number, heightAt: HeightAt, around: number): Ground | null {
  return groundAtPixel(camera, col, row, heightAt, around);
}

/**
 * How high above a ground point the thing seen at a pixel is. A vertical line above `base` is a straight line in the
 * photo; the pixel is projected onto that line and the height there is returned, with how far (in pixels) the click was
 * from the line: near 0 when the click really is straight above the base, larger when it is off to the side (the tool
 * still answers, but the two points are not one over the other). Null when the line has no length in the picture
 * (looking straight down it) or a point of it lies behind the camera.
 */
export function heightAbove(camera: Camera, base: Ground, col: number, row: number): { height: number; offPx: number } | null {
  const at = (h: number): [number, number] | null => camera.groundToPixel(base.x, base.y, base.z + h);
  const STEP = 1;
  const LIMIT = 3000; // no height in this state is beyond a few hundred feet
  let h = 0;
  // Gauss-Newton on the one unknown: the picture position moves almost linearly with the height, so it settles in a few steps.
  for (let i = 0; i < 20; i++) {
    const p = at(h), q = at(h + STEP);
    if (!p || !q) return null;
    const jx = (q[0] - p[0]) / STEP, jy = (q[1] - p[1]) / STEP;
    const jj = jx * jx + jy * jy;
    if (jj < 1e-9) return null;
    const step = ((col - p[0]) * jx + (row - p[1]) * jy) / jj;
    h = Math.max(-LIMIT, Math.min(LIMIT, h + step));
    if (Math.abs(step) < 1e-5) break;
  }
  const p = at(h);
  if (!p) return null;
  return { height: h, offPx: Math.hypot(col - p[0], row - p[1]) };
}

export const distance2d = (a: Ground, b: Ground): number => Math.hypot(b.x - a.x, b.y - a.y);
export const distance3d = (a: Ground, b: Ground): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** The length of a path through the points, level (2D) or along straight lines that follow their heights (3D). */
export function pathLength(points: readonly Ground[], mode: '2d' | '3d'): number {
  const step = mode === '2d' ? distance2d : distance3d;
  let total = 0;
  for (let i = 1; i < points.length; i++) total += step(points[i - 1]!, points[i]!);
  return total;
}

/** The perimeter of a closed outline (2D). */
export function perimeter(points: readonly Ground[]): number {
  return points.length < 2 ? 0 : pathLength(points, '2d') + distance2d(points[points.length - 1]!, points[0]!);
}

/** The area of a polygon seen from above, in square feet (the shoelace formula; the sign of the winding is dropped). */
export function polygonArea(points: readonly Ground[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/** Whether an even-odd test puts a place inside a polygon. */
function inside(points: readonly Ground[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * The area of the ground surface under a polygon, in square feet: the flat area times the mean of sqrt(1 + slope²)
 * over the polygon, which is what a surface z = f(x, y) adds to its shadow. The slope is read off the terrain by
 * central differences on a grid of sample places (at most about 40,000 of them), so it is exact for a plane and follows
 * the patch's own cells elsewhere.
 */
export function surfaceArea(points: readonly Ground[], heightAt: HeightAt): number {
  const flat = polygonArea(points);
  if (points.length < 3 || flat === 0) return 0;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const spacing = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / 40000));
  const d = Math.max(2, spacing / 2); // for the slope: far enough apart to see it, near enough to stay local
  const factorAt = (x: number, y: number): number => {
    const gx = (heightAt(x + d, y) - heightAt(x - d, y)) / (2 * d);
    const gy = (heightAt(x, y + d) - heightAt(x, y - d)) / (2 * d);
    return Math.sqrt(1 + gx * gx + gy * gy);
  };
  let sum = 0, count = 0;
  for (let y = y0 + spacing / 2; y < y1; y += spacing) {
    for (let x = x0 + spacing / 2; x < x1; x += spacing) {
      if (inside(points, x, y)) { sum += factorAt(x, y); count++; }
    }
  }
  if (count === 0) { // a sliver thinner than the sample spacing: use its middle
    sum = factorAt(xs.reduce((s, v) => s + v, 0) / xs.length, ys.reduce((s, v) => s + v, 0) / ys.length);
    count = 1;
  }
  return flat * (sum / count);
}

/** Whether a closed outline crosses itself, which makes its area a difference of parts and not what it looks like. */
export function crossesItself(points: readonly Ground[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  const side = (a: Ground, b: Ground, c: Ground): number => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // these two sides share a corner
      const c = points[j]!, d = points[(j + 1) % n]!;
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
    }
  }
  return false;
}

// --- words for the numbers ---

const group = (value: number, digits: number): string => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A length in feet and metres (and miles once it is over a mile), with the precision the imagery supports. */
export function formatLength(feet: number): string {
  const digits = Math.abs(feet) < 1000 ? 1 : 0;
  const parts = [`${group(feet, digits)} ft`, `${group(feet * METRES_PER_FOOT, digits)} m`];
  if (Math.abs(feet) >= FEET_PER_MILE) parts.push(`${group(feet / FEET_PER_MILE, 2)} mi`);
  return `${parts[0]} (${parts.slice(1).join(' · ')})`;
}

/** An area in square feet, with acres and square metres. */
export function formatArea(squareFeet: number): string {
  const digits = squareFeet < 1000 ? 1 : 0;
  const acres = squareFeet / SQUARE_FEET_PER_ACRE;
  const squareMetres = squareFeet * METRES_PER_FOOT * METRES_PER_FOOT;
  return `${group(squareFeet, digits)} ft² (${group(acres, acres < 10 ? 3 : 1)} acres · ${group(squareMetres, squareMetres < 1000 ? 1 : 0)} m²)`;
}

/** A length in feet only, short enough for a label on a drawing. */
export const formatFeet = (feet: number): string => `${group(feet, Math.abs(feet) < 1000 ? 1 : 0)} ft`;

/** An area short enough for a label: square feet, or acres once it is over an acre. */
export function formatAreaShort(squareFeet: number): string {
  return squareFeet >= SQUARE_FEET_PER_ACRE ? `${group(squareFeet / SQUARE_FEET_PER_ACRE, 2)} acres` : `${group(squareFeet, squareFeet < 1000 ? 1 : 0)} ft²`;
}

/** One coordinate as degrees, minutes and seconds (to 0.01 seconds, about 0.3 m), like 37° 24′ 05.08″ N. */
function degMinSec(value: number, positive: string, negative: string): string {
  const abs = Math.abs(value);
  let degrees = Math.floor(abs);
  let minutes = Math.floor((abs - degrees) * 60);
  let seconds = Math.round(((abs - degrees) * 60 - minutes) * 60 * 100) / 100;
  if (seconds >= 60) { seconds -= 60; minutes += 1; } // 59.996 seconds rounds up to a whole minute
  if (minutes >= 60) { minutes -= 60; degrees += 1; }
  return `${degrees}° ${String(minutes).padStart(2, '0')}′ ${seconds.toFixed(2).padStart(5, '0')}″ ${value < 0 ? negative : positive}`;
}

/** A latitude and longitude in degrees, minutes and seconds: 37° 24′ 05.08″ N, 85° 59′ 43.36″ W. */
export const formatDms = (lat: number, lon: number): string => `${degMinSec(lat, 'N', 'S')}, ${degMinSec(lon, 'E', 'W')}`;

/** A height change with its sign, like +12.3 ft (+3.7 m). */
export function formatRise(feet: number): string {
  const sign = feet > 0 ? '+' : feet < 0 ? '−' : '';
  const abs = Math.abs(feet);
  const digits = abs < 1000 ? 1 : 0;
  return `${sign}${group(abs, digits)} ft (${sign}${group(abs * METRES_PER_FOOT, digits)} m)`;
}

/** A slope as a percentage. */
export const formatPercent = (fraction: number): string => `${group(fraction * 100, 1)}%`;
