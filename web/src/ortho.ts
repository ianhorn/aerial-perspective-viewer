// Laying a photo on the ground. An oblique photo shows the ground from the side; to draw it on a map, each point
// of the picture to be made (a rectangle of ground, on the map) is traced back into the photo: which ground is
// there, how high it is (from the terrain), and where the camera sees that point. The photo's colour at that spot
// becomes the picture's colour. Because the height comes from the terrain, hills land where they really are.
// Pure arithmetic on pixel arrays, no map and no browser, so it is tested on its own.

import type { Camera } from './camera.ts';
import { lonLatToGrid } from './lcc.ts';
import { lonLatToWorld, worldToLonLat } from './mercator.ts';
import type { LngLat } from './scene.ts';

export interface Raster { width: number; height: number; data: Uint8ClampedArray }

/** Where each of a grid of nodes across the output picture lands in the source: `col` and `row`, NaN where nowhere. */
export interface WarpMesh { step: number; nodesX: number; nodesY: number; col: Float32Array; row: Float32Array }

/**
 * Trace the output picture back into the source at a grid of nodes `step` pixels apart (the last node falls on the
 * far edge). `node` takes a position in the output, in pixels, and returns a position in the source, or null.
 * Between nodes the trace is smooth, so the picture is filled by interpolating it (see `warp`).
 */
export function buildMesh(width: number, height: number, step: number, node: (x: number, y: number) => readonly [number, number] | null): WarpMesh {
  const nodesX = Math.ceil(width / step) + 1, nodesY = Math.ceil(height / step) + 1;
  const col = new Float32Array(nodesX * nodesY), row = new Float32Array(nodesX * nodesY);
  for (let j = 0; j < nodesY; j++) {
    for (let i = 0; i < nodesX; i++) {
      const at = node(Math.min(width, i * step), Math.min(height, j * step));
      col[j * nodesX + i] = at ? at[0] : NaN;
      row[j * nodesX + i] = at ? at[1] : NaN;
    }
  }
  return { step, nodesX, nodesY, col, row };
}

/**
 * Fill a picture of `width` by `height` from `source` by looking up each pixel's position in the mesh (blended
 * between the four nearest nodes) and reading the source there, blending the four nearest source pixels. A
 * pixel whose position falls outside the source, or where the mesh has no answer, is left transparent.
 */
export function warp(source: Raster, mesh: WarpMesh, width: number, height: number): Raster {
  const out = new Uint8ClampedArray(width * height * 4);
  const { step, nodesX, nodesY, col, row } = mesh;
  const sw = source.width, sh = source.height, sd = source.data;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / step;
    const j = Math.min(nodesY - 2, Math.max(0, Math.floor(v)));
    const fv = v - j;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / step;
      const i = Math.min(nodesX - 2, Math.max(0, Math.floor(u)));
      const fu = u - i;
      const a = j * nodesX + i, b = a + 1, c = a + nodesX, d = c + 1;
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
      const cs = col[a]! * w00 + col[b]! * w10 + col[c]! * w01 + col[d]! * w11;
      const rs = row[a]! * w00 + row[b]! * w10 + row[c]! * w01 + row[d]! * w11;
      if (!(cs >= 0 && cs <= sw && rs >= 0 && rs <= sh)) continue; // outside the source, or NaN: transparent
      // Source pixel i covers [i, i + 1) with its middle at i + 0.5, so blend around cs - 0.5.
      const fx = cs - 0.5, fy = rs - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
      const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4, p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
      const o = (y * width + x) * 4;
      const k00 = (1 - tx) * (1 - ty), k10 = tx * (1 - ty), k01 = (1 - tx) * ty, k11 = tx * ty;
      out[o] = sd[p00]! * k00 + sd[p10]! * k10 + sd[p01]! * k01 + sd[p11]! * k11;
      out[o + 1] = sd[p00 + 1]! * k00 + sd[p10 + 1]! * k10 + sd[p01 + 1]! * k01 + sd[p11 + 1]! * k11;
      out[o + 2] = sd[p00 + 2]! * k00 + sd[p10 + 2]! * k10 + sd[p01 + 2]! * k01 + sd[p11 + 2]! * k11;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

export interface OrthoRequest {
  /** The ground to draw: four corners on the map, top-left, top-right, bottom-right, bottom-left of the picture. */
  corners: [LngLat, LngLat, LngLat, LngLat];
  /** The size of the picture to make, in pixels. */
  width: number;
  height: number;
  camera: Camera;
  /** The ground height in feet at a grid position (EPSG:3089): the terrain, or a flat guess where it has none. */
  heightAt: (x: number, y: number) => number;
  /** The photo as pixels, and how a position in the full-size photo maps to a position in those pixels. */
  source: Raster;
  toSource: (col: number, row: number) => readonly [number, number];
  /** Nodes of the trace this many pixels apart. */
  step?: number;
}

/**
 * The picture of the ground under `corners` made from the photo. The output is spread between the corners the
 * way the map spreads an image (evenly in Web Mercator), so putting it on the map at those corners is exact.
 */
export function orthoRaster(req: OrthoRequest): Raster {
  const trace = makeTrace(req.corners, req.width, req.height, req.camera, req.heightAt);
  const node = (px: number, py: number): readonly [number, number] | null => {
    const photo = trace(px, py);
    return photo && req.toSource(photo[0], photo[1]);
  };
  const mesh = buildMesh(req.width, req.height, req.step ?? 16, node);
  return warp(req.source, mesh, req.width, req.height);
}

/**
 * The trace from a position in the output picture (pixels) to a position in the full-size photo: the ground there,
 * its height, and where the camera sees it. Null where the camera cannot see the point.
 */
export function makeTrace(
  corners: [LngLat, LngLat, LngLat, LngLat], width: number, height: number, camera: Camera, heightAt: (x: number, y: number) => number,
): (px: number, py: number) => readonly [number, number] | null {
  const [tl, tr, br, bl] = corners.map(([lon, lat]) => lonLatToWorld(lon, lat)) as [[number, number], [number, number], [number, number], [number, number]];
  return (px, py) => {
    const u = px / width, v = py / height;
    const wx = (1 - v) * ((1 - u) * tl[0] + u * tr[0]) + v * ((1 - u) * bl[0] + u * br[0]);
    const wy = (1 - v) * ((1 - u) * tl[1] + u * tr[1]) + v * ((1 - u) * bl[1] + u * br[1]);
    const [lon, lat] = worldToLonLat(wx, wy);
    const [gx, gy] = lonLatToGrid(lon, lat);
    return camera.groundToPixel(gx, gy, heightAt(gx, gy));
  };
}
