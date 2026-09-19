// A thumbnail of one photo around the point that was clicked, with a ring on the point. Only the few tiles that
// cover the crop are read, at the smallest level with enough pixels for a thumbnail, so it costs tens of
// kilobytes, not the smallest overview of the whole photo.

import type { Camera } from './camera.ts';
import { levelsOf, loadRegion, planRegion, sharedTiles } from './cog.ts';
import { cropAround } from './thumb.ts';

export interface CropThumbRequest {
  url: string;
  camera: Camera;
  /** The clicked point: grid feet (EPSG:3089) and the ground height there. */
  point: { x: number; y: number; z: number };
  /** The size the thumbnail is shown at, in CSS pixels. */
  width: number;
  height: number;
  pixelRatio: number;
  /** Ground across the thumbnail, in feet. */
  groundWidthFt?: number;
  signal?: AbortSignal;
}

/** A ring (dark outside, white inside, a red dot in the middle) that reads on both dark trees and pale roofs. */
function drawRing(context: CanvasRenderingContext2D, x: number, y: number, dpr: number): void {
  context.beginPath();
  context.arc(x, y, 5 * dpr, 0, Math.PI * 2);
  context.lineWidth = 3.6 * dpr;
  context.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  context.stroke();
  context.lineWidth = 1.8 * dpr;
  context.strokeStyle = '#fff';
  context.stroke();
  context.beginPath();
  context.arc(x, y, 1.6 * dpr, 0, Math.PI * 2);
  context.fillStyle = '#e53935';
  context.fill();
}

// A thumbnail is looked at small, so a level with 60% of the pixels it would ideally have is plenty, and is
// usually one step smaller (a quarter of the bytes).
const THUMB_TOLERANCE = 0.6;

/** The thumbnail and the bytes its tiles cost (headers are counted in `cogStats`), or null when the photo cannot show the point (the caller then falls back to the whole photo). */
export async function cropThumbnail(req: CropThumbRequest): Promise<{ canvas: HTMLCanvasElement; bytes: number } | null> {
  const crop = cropAround(req.camera, req.point, req.groundWidthFt);
  if (!crop) return null;
  const outW = Math.round(req.width * req.pixelRatio), outH = Math.round(req.height * req.pixelRatio);
  const levels = await levelsOf(req.url, req.signal);
  const plan = planRegion(levels, { x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height }, outW / crop.width, 12, 4096, THUMB_TOLERANCE);
  if (!plan) return null;
  const { canvas: region, bytes } = await loadRegion(req.url, plan, { signal: req.signal, cache: sharedTiles });

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const context = out.getContext('2d');
  if (!context) return null;
  context.imageSmoothingQuality = 'high';
  // The crop in the level's own pixels, relative to the tiles that were read.
  context.drawImage(
    region, crop.x * plan.scaleX - plan.rect.x, crop.y * plan.scaleY - plan.rect.y, crop.width * plan.scaleX, crop.height * plan.scaleY,
    0, 0, outW, outH,
  );
  drawRing(context, crop.markerX * outW, crop.markerY * outH, req.pixelRatio);
  return { canvas: out, bytes };
}
