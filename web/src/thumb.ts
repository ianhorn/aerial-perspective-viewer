// Thumbnails in the results list. A photo's smallest overview can be far bigger than a list row (1287 px
// wide, about 5 MB decoded), so each one is shrunk to the size it is shown at and the big canvas is dropped.

/** The size of a picture scaled down to fit in a box, keeping its shape. Never larger than the original. */
export function fitInside(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A copy of a canvas shrunk to fit the box (in device pixels). */
export function shrink(source: HTMLCanvasElement, maxWidth: number, maxHeight: number): HTMLCanvasElement {
  const size = fitInside(source.width, source.height, maxWidth, maxHeight);
  const out = document.createElement('canvas');
  out.width = size.width;
  out.height = size.height;
  const context = out.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, size.width, size.height);
  return out;
}

// --- Thumbnails clipped to the point that was clicked ---------------------------------------------------------------

import type { Camera } from './camera.ts';

export interface Crop {
  /** The crop in full-size photo pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where the clicked point falls in the crop, as fractions of its width and height (0 to 1 unless the point is off the photo). */
  markerX: number;
  markerY: number;
  /** The ground the crop covers, across, in feet at the point. */
  groundWidthFt: number;
}

/**
 * The part of a photo to show in a thumbnail of the clicked point: centred on where the camera sees `point` (grid
 * feet, with its height), and about `groundWidthFt` of ground across, at `aspect` (width over height, in photo
 * pixels, so the picture is not stretched). Moved inside the photo when the point is near its edge, so the
 * marker is then off centre. Null when the camera cannot see the point.
 */
export function cropAround(camera: Camera, point: { x: number; y: number; z: number }, groundWidthFt = 250, aspect = 4 / 3): Crop | null {
  const seen = camera.groundToPixel(point.x, point.y, point.z);
  if (!seen) return null;
  const [col, row] = seen;
  // How much ground one photo pixel covers here, across the photo, found by looking a few pixels along.
  const step = 25;
  const here = camera.pixelToGround(col, row, point.z);
  const along = camera.pixelToGround(col + step, row, point.z);
  if (!here || !along) return null;
  const feetPerPixel = Math.hypot(along[0] - here[0], along[1] - here[1]) / step;
  if (!(feetPerPixel > 0)) return null;

  let width = groundWidthFt / feetPerPixel;
  let height = width / aspect;
  const scale = Math.min(1, camera.widthPx / width, camera.heightPx / height); // never bigger than the photo
  width *= scale;
  height *= scale;
  const x = Math.min(camera.widthPx - width, Math.max(0, col - width / 2));
  const y = Math.min(camera.heightPx - height, Math.max(0, row - height / 2));
  return { x, y, width, height, markerX: (col - x) / width, markerY: (row - y) / height, groundWidthFt: width * feetPerPixel };
}
