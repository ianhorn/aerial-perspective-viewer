// Several photos in one picture, without ghosts. Anything standing above the ground (a van, a roof) is seen from each
// photo's own camera position, so two photos put it in slightly different places, and averaging them would draw it
// twice. So photos are not averaged: they are stacked. The photo listed first is drawn wherever it reaches, the next
// shows only where the first does not, and so on, and each photo fades out over a narrow band at its own edge, so
// the join between two is a short blend and not a hard line. Most of the screen comes from one photo.
//
// The order is the priority: the photo the user chose, then the photos that cover the most of the view.

import type { Camera } from './camera.ts';
import { buildMesh, makeTrace, type Raster, type WarpMesh } from './ortho.ts';
import type { LngLat } from './scene.ts';

/** One photo's part of the picture: its camera and ground, and the pixels that have been read from it. */
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
}

export interface MosaicRequest {
  corners: [LngLat, LngLat, LngLat, LngLat];
  width: number;
  height: number;
  /** In priority order: the first is on top. */
  frames: readonly MosaicFrame[];
  step?: number;
}

/**
 * The band at a photo's own edge over which it fades into what is below it, as a fraction of its shorter side (2%
 * is 60 to 150 photo pixels, 15 to 35 ft: a photo is least reliable at its border, so it is not worth showing there).
 */
const EDGE_FADE = 0.02;

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** How much of a photo shows at a position in it (full-size pixels): 0 at its edge, 1 from the fade band inward. */
export function edgeWeight(col: number, row: number, width: number, height: number): number {
  if (!(col >= 0 && col <= width && row >= 0 && row <= height)) return 0;
  return smooth(Math.min(col, width - col, row, height - row) / (EDGE_FADE * Math.min(width, height)));
}

/**
 * Which photos (in priority order) the picture needs, judged at a grid of ground points across it. A photo that
 * reaches none of the points still uncovered by the photos above it adds nothing, since the stack never shows it,
 * so it need not be read. A point counts as covered once a photo shows it in full (past its fade band), and the
 * photo below is still needed where one only fades in.
 */
export function neededFrames(
  frames: readonly { camera: Camera; heightAt: (x: number, y: number) => number }[], ground: readonly (readonly [number, number])[],
): boolean[] {
  let uncovered = ground.slice();
  return frames.map(({ camera, heightAt }) => {
    if (uncovered.length === 0) return false;
    let reaches = false;
    const left: (readonly [number, number])[] = [];
    for (const point of uncovered) {
      const seen = camera.groundToPixel(point[0], point[1], heightAt(point[0], point[1]));
      const weight = seen ? edgeWeight(seen[0], seen[1], camera.widthPx, camera.heightPx) : 0;
      if (weight > 0) reaches = true;
      if (weight < 0.999) left.push(point);
    }
    uncovered = left;
    return reaches;
  });
}

interface Traced {
  mesh: WarpMesh;
  /** For each cell of the mesh (a square of four nodes): 1 if the photo can reach any of it, 0 if it lies wholly outside the photo. */
  active: Uint8Array;
}

/** The trace of the picture into one photo at a grid of nodes, and which cells of it the photo can reach at all. */
function traceFrame(req: MosaicRequest, frame: MosaicFrame, step: number): Traced {
  const trace = makeTrace(req.corners, req.width, req.height, frame.camera, frame.heightAt);
  const mesh = buildMesh(req.width, req.height, step, trace);
  const { nodesX, nodesY, col, row } = mesh;
  // A cell whose four nodes all lie beyond the same side of the photo (or that has no answer) has none of the photo
  // in it, so its pixels are not looked at for this photo at all.
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
  return { mesh, active };
}

export function mosaicRaster(req: MosaicRequest): Raster {
  const { width, height } = req;
  const out = new Uint8ClampedArray(width * height * 4);
  const step = req.step ?? 16;
  const traced = req.frames.map((frame) => traceFrame(req, frame, step));
  const count = req.frames.length;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Stack the photos from the top down, each taking what the ones above it let through, until nothing is left.
      let sumR = 0, sumG = 0, sumB = 0, covered = 0;
      for (let k = 0; k < count && covered < 0.999; k++) {
        const frame = req.frames[k]!, { mesh, active } = traced[k]!;
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
        const edge = edgeWeight(col, row, W, H);
        if (edge <= 0) continue;
        // Only where the tiles that were read cover it.
        const sx = col * frame.scaleX - frame.offsetX - 0.5, sy = row * frame.scaleY - frame.offsetY - 0.5;
        const sw = frame.source.width, sh = frame.source.height;
        if (sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5) continue;

        // The photo's colour there, blending the four nearest pixels of what was read from it.
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const tx = Math.max(0, Math.min(1, sx - x0)), ty = Math.max(0, Math.min(1, sy - y0));
        const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4, p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
        const k00 = (1 - tx) * (1 - ty), k10 = tx * (1 - ty), k01 = (1 - tx) * ty, k11 = tx * ty;
        const sd = frame.source.data;
        const share = (1 - covered) * edge; // how much of this photo shows through what is above it
        sumR += share * (sd[p00]! * k00 + sd[p10]! * k10 + sd[p01]! * k01 + sd[p11]! * k11);
        sumG += share * (sd[p00 + 1]! * k00 + sd[p10 + 1]! * k10 + sd[p01 + 1]! * k01 + sd[p11 + 1]! * k11);
        sumB += share * (sd[p00 + 2]! * k00 + sd[p10 + 2]! * k10 + sd[p01 + 2]! * k01 + sd[p11 + 2]! * k11);
        covered += share;
      }
      if (covered > 0) {
        const o = (y * width + x) * 4;
        out[o] = sumR / covered;
        out[o + 1] = sumG / covered;
        out[o + 2] = sumB / covered;
        out[o + 3] = 255 * Math.min(1, covered);
      }
    }
  }
  return { width, height, data: out };
}
