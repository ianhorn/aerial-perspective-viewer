// The browser side of `ortho.ts`: canvases in, canvases out, and the picture for a whole photo.

import type { Camera } from './camera.ts';
import { lonLatToWorld, worldToLonLat } from './mercator.ts';
import { orthoRaster, type Raster } from './ortho.ts';
import type { LngLat } from './scene.ts';
import type { Terrain } from './terrain.ts';

export function canvasToRaster(canvas: HTMLCanvasElement): Raster {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2D canvas context');
  const { width, height, data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width, height, data };
}

export function rasterToCanvas(raster: Raster): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');
  // A raster made here is backed by a plain ArrayBuffer, which is what ImageData wants; the type just can't see it.
  context.putImageData(new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height), 0, 0);
  return canvas;
}

/**
 * The ground height at a grid position: the photo's terrain patch, held at its edge value just outside it and
 * replaced by `fallback` where it has no data, or the flat guess for the whole photo when there is no patch.
 */
export function groundHeight(terrain: Terrain | null, fallback: number): (x: number, y: number) => number {
  if (!terrain) return () => fallback;
  const { xMin, yMin, xMax, yMax } = terrain.extent;
  return (x, y) => terrain.heightAt(Math.min(xMax, Math.max(xMin, x)), Math.min(yMax, Math.max(yMin, y))) ?? fallback;
}

export interface WholePhoto {
  canvas: HTMLCanvasElement;
  /** Where it goes on the map: top-left, top-right, bottom-right, bottom-left. */
  corners: [LngLat, LngLat, LngLat, LngLat];
}

/**
 * The whole photo laid on the ground: the small preview traced onto the terrain, in a picture that covers the
 * photo's footprint (`footprint`: its corners as lon/lat, with a few percent of margin) and is at most `longSide`
 * pixels along its longer side.
 */
export function wholePhotoOnGround(
  footprint: readonly LngLat[], camera: Camera, heightAt: (x: number, y: number) => number, preview: HTMLCanvasElement, longSide = 1280,
): WholePhoto {
  const world = footprint.map(([lon, lat]) => lonLatToWorld(lon, lat));
  const xs = world.map((p) => p[0]), ys = world.map((p) => p[1]);
  const mx = (Math.max(...xs) - Math.min(...xs)) * 0.03, my = (Math.max(...ys) - Math.min(...ys)) * 0.03;
  const x0 = Math.min(...xs) - mx, x1 = Math.max(...xs) + mx, y0 = Math.min(...ys) - my, y1 = Math.max(...ys) + my;
  const scale = longSide / Math.max(x1 - x0, y1 - y0);
  const width = Math.max(2, Math.round((x1 - x0) * scale)), height = Math.max(2, Math.round((y1 - y0) * scale));
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => worldToLonLat(x!, y!)) as [LngLat, LngLat, LngLat, LngLat];
  const raster = orthoRaster({
    corners, width, height, camera, heightAt,
    source: canvasToRaster(preview),
    toSource: (col, row) => [(col / camera.widthPx) * preview.width, (row / camera.heightPx) * preview.height],
  });
  return { canvas: rasterToCanvas(raster), corners };
}
