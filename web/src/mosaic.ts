// Several photos in one picture. Where photos overlap, each pixel is taken mostly from the photo that has the
// most to offer there, and the seam between two is a short blend, not a hard edge or a smear.
//
// Each photo gets a weight at every pixel, from 0 to 1:
//   - near the photo's own edge it fades to 0 (a photo is least reliable at its border, and this softens the
//     outline where a photo ends over the map),
//   - where the photo has fewer pixels than the screen (it is being enlarged, so it is blurry) it is scaled down in
//     proportion, so a sharper photo wins where two overlap.
// A pixel's colour is the weighted average with the weights raised to a power, which turns a broad average into
// a pick of the strongest photo with a narrow blend where two are close. Its transparency comes only from the
// photos' edge fades (their sum, up to 1), so the picture fades out where no photo reaches, and a photo that is
// merely blurry is still drawn in full: sharpness decides which photo wins a pixel, not whether it is drawn.

import type { Camera } from './camera.ts';
import { buildMesh, makeTrace, type Raster, type WarpMesh } from './ortho.ts';
import type { LngLat } from './scene.ts';

/** One photo's part of the picture: its camera and terrain, and the pixels that have been read from it. */
export interface MosaicFrame {
  camera: Camera;
  heightAt: (x: number, y: number) => number;
  /** The pixels read from the photo (tiles of one of its levels). */
  source: Raster;
  /** A position in the full-size photo maps to `col * scaleX - offsetX` in `source` (and the same for rows). */
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  /** More than 1 favours this photo (the one the user chose); 1 or absent is neutral. */
  bias?: number;
}

export interface MosaicRequest {
  corners: [LngLat, LngLat, LngLat, LngLat];
  width: number;
  height: number;
  frames: readonly MosaicFrame[];
  step?: number;
}

/** How fast weights are sharpened: 1 is a plain average; 4 makes a photo with twice another's weight count sixteen times as much. */
const SHARPEN = 4;
/** A photo whose weight is under this share of the strongest at a pixel is not read there (sharpened, it would count for under 3%). */
const CUTOFF = 0.4;
/** The fade at a photo's edge, as a fraction of its shorter side. */
const EDGE_FADE = 0.05;

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

interface Traced {
  mesh: WarpMesh;
  quality: Float32Array;
  /** For each cell of the mesh (a square of four nodes): 1 if the photo can reach any of it, 0 if it lies wholly outside the photo. */
  active: Uint8Array;
}

/** The trace of the picture into one photo at a grid of nodes, and at each node how many photo pixels one output pixel covers (at most 1). */
function traceFrame(req: MosaicRequest, frame: MosaicFrame, step: number): Traced {
  const trace = makeTrace(req.corners, req.width, req.height, frame.camera, frame.heightAt);
  const mesh = buildMesh(req.width, req.height, step, trace);
  const { nodesX, nodesY, col, row } = mesh;
  const quality = new Float32Array(nodesX * nodesY);
  for (let j = 0; j < nodesY; j++) {
    for (let i = 0; i < nodesX; i++) {
      const at = j * nodesX + i;
      // A step to the next node across and down (or back, at the far edge): photo pixels covered per output pixel.
      const i2 = i + 1 < nodesX ? i + 1 : i - 1, j2 = j + 1 < nodesY ? j + 1 : j - 1;
      const across = i2 >= 0 ? Math.hypot(col[j * nodesX + i2]! - col[at]!, row[j * nodesX + i2]! - row[at]!) / (Math.abs(i2 - i) * step) : NaN;
      const down = j2 >= 0 ? Math.hypot(col[j2 * nodesX + i]! - col[at]!, row[j2 * nodesX + i]! - row[at]!) / (Math.abs(j2 - j) * step) : NaN;
      // The coarser direction decides how blurry the photo is here. NaN (no answer) becomes 0 through the comparison.
      const density = Math.min(across, down);
      quality[at] = density >= 1 ? 1 : density > 0 ? density : 0;
    }
  }

  // A cell whose four nodes all lie beyond the same side of the photo (or that has no answer) has none of the photo in it,
  // so its pixels are not looked at for this photo at all. This is most of the picture for a photo that covers a part of it.
  const W = frame.camera.widthPx, H = frame.camera.heightPx;
  const active = new Uint8Array((nodesX - 1) * (nodesY - 1));
  for (let j = 0; j < nodesY - 1; j++) {
    for (let i = 0; i < nodesX - 1; i++) {
      const ids = [j * nodesX + i, j * nodesX + i + 1, (j + 1) * nodesX + i, (j + 1) * nodesX + i + 1];
      let missing = false, left = 0, right = 0, above = 0, below = 0;
      for (const n of ids) {
        const c = col[n]!, r = row[n]!;
        if (Number.isNaN(c) || Number.isNaN(r)) { missing = true; break; }
        if (c < 0) left++; else if (c > W) right++;
        if (r < 0) above++; else if (r > H) below++;
      }
      active[j * (nodesX - 1) + i] = missing || left === 4 || right === 4 || above === 4 || below === 4 ? 0 : 1;
    }
  }
  return { mesh, quality, active };
}

export function mosaicRaster(req: MosaicRequest): Raster {
  const { width, height } = req;
  const out = new Uint8ClampedArray(width * height * 4);
  const step = req.step ?? 16;
  const traced = req.frames.map((frame) => traceFrame(req, frame, step));
  const count = req.frames.length;
  // Per pixel, first each photo's weight and position (cheap), then colours only from photos that can still matter.
  const weights = new Float64Array(count), cols = new Float64Array(count), rows = new Float64Array(count);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let strongest = 0, coverage = 0;
      for (let k = 0; k < count; k++) {
        weights[k] = 0;
        const frame = req.frames[k]!, { mesh, quality, active } = traced[k]!;
        const v = (y + 0.5) / mesh.step, u = (x + 0.5) / mesh.step;
        const j = Math.min(mesh.nodesY - 2, Math.max(0, Math.floor(v))), i = Math.min(mesh.nodesX - 2, Math.max(0, Math.floor(u)));
        if (!active[j * (mesh.nodesX - 1) + i]) continue; // this photo does not reach here
        const fu = u - i, fv = v - j;
        const a = j * mesh.nodesX + i, b = a + 1, c = a + mesh.nodesX, d = c + 1;
        const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
        const col = mesh.col[a]! * w00 + mesh.col[b]! * w10 + mesh.col[c]! * w01 + mesh.col[d]! * w11;
        const row = mesh.row[a]! * w00 + mesh.row[b]! * w10 + mesh.row[c]! * w01 + mesh.row[d]! * w11;
        const W = frame.camera.widthPx, H = frame.camera.heightPx;
        if (!(col >= 0 && col <= W && row >= 0 && row <= H)) continue; // outside the photo, or NaN
        const edge = smooth(Math.min(col, W - col, row, H - row) / (EDGE_FADE * Math.min(W, H)));
        if (edge <= 0) continue;
        const q = quality[a]! * w00 + quality[b]! * w10 + quality[c]! * w01 + quality[d]! * w11;
        const weight = edge * q * (frame.bias ?? 1);
        if (!(weight > 0)) continue;
        // Only where the tiles that were read cover it.
        const sx = col * frame.scaleX - frame.offsetX, sy = row * frame.scaleY - frame.offsetY;
        if (sx < 0 || sy < 0 || sx > frame.source.width || sy > frame.source.height) continue;
        weights[k] = weight; cols[k] = col; rows[k] = row;
        coverage += edge;
        if (weight > strongest) strongest = weight;
      }
      if (strongest <= 0) continue;

      // A photo with under 40% of the strongest weight would count for under 3% once the weights are sharpened, so its colour is not read.
      const cutoff = strongest * CUTOFF;
      let sumR = 0, sumG = 0, sumB = 0, sharp = 0;
      for (let k = 0; k < count; k++) {
        if (weights[k]! < cutoff || !(weights[k]! > 0)) continue;
        const frame = req.frames[k]!;
        // Read the photo's colour there, blending the four nearest pixels of what was read from it.
        const sx = cols[k]! * frame.scaleX - frame.offsetX - 0.5, sy = rows[k]! * frame.scaleY - frame.offsetY - 0.5;
        const sw = frame.source.width, sh = frame.source.height;
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const tx = Math.max(0, Math.min(1, sx - x0)), ty = Math.max(0, Math.min(1, sy - y0));
        const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4, p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
        const k00 = (1 - tx) * (1 - ty), k10 = tx * (1 - ty), k01 = (1 - tx) * ty, k11 = tx * ty;
        const sd = frame.source.data;
        const ws = weights[k]! ** SHARPEN;
        sumR += ws * (sd[p00]! * k00 + sd[p10]! * k10 + sd[p01]! * k01 + sd[p11]! * k11);
        sumG += ws * (sd[p00 + 1]! * k00 + sd[p10 + 1]! * k10 + sd[p01 + 1]! * k01 + sd[p11 + 1]! * k11);
        sumB += ws * (sd[p00 + 2]! * k00 + sd[p10 + 2]! * k10 + sd[p01 + 2]! * k01 + sd[p11 + 2]! * k11);
        sharp += ws;
      }
      const o = (y * width + x) * 4;
      out[o] = sumR / sharp;
      out[o + 1] = sumG / sharp;
      out[o + 2] = sumB / sharp;
      out[o + 3] = 255 * Math.min(1, coverage);
    }
  }
  return { width, height, data: out };
}
