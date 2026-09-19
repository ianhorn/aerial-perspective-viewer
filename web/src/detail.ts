// Where in a photo the screen is looking, and how sharp it needs to be there. Pure geometry: the map is asked
// for nothing here, so it is tested on its own. `detail-layer.ts` puts it on the map.

import type { Camera } from './camera.ts';

export interface PhotoRegion { x0: number; y0: number; x1: number; y1: number }

/**
 * The part of the photo, in full-size pixels, under a set of ground points (the corners and edges of the screen,
 * as grid coordinates in feet), grown by `margin` so a small pan does not need new pixels at once. Clamped to the
 * photo. If a point is beyond the camera's horizon the answer is the whole photo, since nothing can be said
 * about it; null when the screen shows none of the photo.
 */
export function photoRegionUnder(camera: Camera, groundZ: number, ground: readonly (readonly [number, number])[], margin = 0.05): PhotoRegion | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ground) {
    const pixel = camera.groundToPixel(x, y, groundZ);
    if (!pixel) return { x0: 0, y0: 0, x1: camera.widthPx, y1: camera.heightPx };
    x0 = Math.min(x0, pixel[0]); x1 = Math.max(x1, pixel[0]);
    y0 = Math.min(y0, pixel[1]); y1 = Math.max(y1, pixel[1]);
  }
  if (!Number.isFinite(x0)) return null;
  const mx = (x1 - x0) * margin, my = (y1 - y0) * margin;
  const region = {
    x0: Math.max(0, x0 - mx), y0: Math.max(0, y0 - my),
    x1: Math.min(camera.widthPx, x1 + mx), y1: Math.min(camera.heightPx, y1 + my),
  };
  return region.x1 > region.x0 && region.y1 > region.y0 ? region : null;
}

/**
 * How many screen pixels one full-size photo pixel covers, at its largest inside the region: the photo's far
 * side, where a pixel covers the most ground, needs the most detail. Measured at the region's corners (moved a
 * little inside) and its middle. `toScreen` turns grid feet into screen pixels. Null when nothing could be measured.
 */
export function maxScreenScale(
  camera: Camera, groundZ: number, region: PhotoRegion, toScreen: (x: number, y: number) => readonly [number, number], step = 40,
): number | null {
  const inset = Math.min(step, (region.x1 - region.x0) / 4, (region.y1 - region.y0) / 4);
  const spots: [number, number][] = [
    [region.x0 + inset, region.y0 + inset], [region.x1 - inset, region.y0 + inset],
    [region.x1 - inset, region.y1 - inset], [region.x0 + inset, region.y1 - inset],
    [(region.x0 + region.x1) / 2, (region.y0 + region.y1) / 2],
  ];
  let best: number | null = null;
  for (const [col, row] of spots) {
    const here = camera.pixelToGround(col, row, groundZ);
    const right = camera.pixelToGround(col + step, row, groundZ);
    const down = camera.pixelToGround(col, row + step, groundZ);
    if (!here || !right || !down) continue;
    const s = toScreen(here[0], here[1]);
    const sr = toScreen(right[0], right[1]);
    const sd = toScreen(down[0], down[1]);
    const scale = Math.max(Math.hypot(sr[0] - s[0], sr[1] - s[1]), Math.hypot(sd[0] - s[0], sd[1] - s[1])) / step;
    if (Number.isFinite(scale) && (best === null || scale > best)) best = scale;
  }
  return best;
}
