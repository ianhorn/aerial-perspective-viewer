import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';
import { gridToLonLat } from '../src/lcc.ts';
import { type MosaicFrame, mosaicRaster } from '../src/mosaic.ts';
import { orthoRaster, type Raster } from '../src/ortho.ts';

// Cameras looking straight down over flat ground at height 0: at 3000 ft up, with a 100 mm lens and 5 micron
// pixels, a photo pixel is 0.15 ft across and the photo covers 600 by 450 ft.
const lens = { widthPx: 4000, heightPx: 3000, focalMm: 100, ccdResUm: 5, ppxMm: 0, ppyMm: 0 };
const X0 = 4_900_000, Y0 = 3_900_000;
const camera = (x: number, altitude = 3000) => createCamera({ x, y: Y0, z: altitude, omega: 0, phi: 0, kappa: 0 }, lens);
const solid = (r: number, g: number, b: number): Raster => {
  const data = new Uint8ClampedArray(40 * 30 * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { width: 40, height: 30, data };
};
const frame = (x: number, colour: [number, number, number], over: Partial<MosaicFrame> = {}, altitude = 3000): MosaicFrame => ({
  camera: camera(x, altitude), heightAt: () => 0, source: solid(...colour), scaleX: 40 / 4000, scaleY: 30 / 3000, offsetX: 0, offsetY: 0, ...over,
});
// The ground box [xa, xb] by [ya, yb], as an output of the given size.
const box = (xa: number, xb: number, ya: number, yb: number) =>
  [gridToLonLat(xa, yb), gridToLonLat(xb, yb), gridToLonLat(xb, ya), gridToLonLat(xa, ya)] as [[number, number], [number, number], [number, number], [number, number]];
const at = (r: Raster, x: number, y: number) => { const o = (y * r.width + x) * 4; return [r.data[o]!, r.data[o + 1]!, r.data[o + 2]!, r.data[o + 3]!]; };

describe('mosaicRaster: two photos side by side, overlapping', () => {
  // A covers x from X0-300 to X0+300 and B from X0+60 to X0+660, so they overlap from X0+60 to X0+300.
  const req = { corners: box(X0 - 350, X0 + 710, Y0 - 225, Y0 + 225), width: 212, height: 90, frames: [frame(X0, [255, 0, 0]), frame(X0 + 360, [0, 0, 255])] };
  const r = mosaicRaster(req);
  const px = (groundX: number) => Math.round((groundX - (X0 - 350)) / 5); // 5 ft per output pixel

  it('shows each photo where only it reaches', () => {
    const [ar, ag, ab, aa] = at(r, px(X0 - 200), 45);
    assert.deepEqual([ar, ag, ab, aa], [255, 0, 0, 255]);
    const [br, bg, bb, ba] = at(r, px(X0 + 500), 45);
    assert.deepEqual([br, bg, bb, ba], [0, 0, 255, 255]);
  });

  it('blends evenly in the middle of the overlap, where both are equally good', () => {
    const [cr, cg, cb, ca] = at(r, px(X0 + 180), 45);
    assert.ok(Math.abs(cr - 127) <= 3 && cg === 0 && Math.abs(cb - 127) <= 3 && ca === 255, `${cr},${cg},${cb},${ca}`);
  });

  it('favours the photo that is further from its own edge, in a short blend', () => {
    // 10 ft from A's right edge, and 230 ft inside B: A is fading, B is not
    const [cr, , cb, ca] = at(r, px(X0 + 290), 45);
    assert.ok(cr < 25 && cb > 230 && ca === 255, `${cr},${cb},${ca}`);
  });

  it('goes from one photo to the other steadily across the overlap', () => {
    let last = 255;
    for (let g = 60; g <= 300; g += 5) {
      const red = at(r, px(X0 + g), 45)[0]!;
      assert.ok(red <= last + 2, `red rose from ${last} to ${red} at ${g}`);
      last = red;
    }
    assert.ok(at(r, px(X0 + 62), 45)[0]! > 200 && at(r, px(X0 + 298), 45)[0]! < 30);
  });

  it('fades out at the edge of a photo where nothing else reaches, and is clear beyond', () => {
    const alphaAt = (g: number) => at(r, px(g), 45)[3]!;
    assert.ok(alphaAt(X0 - 295) > 3 && alphaAt(X0 - 295) < 130, `${alphaAt(X0 - 295)}`); // 5 ft inside A's edge
    assert.equal(alphaAt(X0 - 200), 255);
    assert.equal(alphaAt(X0 - 340), 0);
    assert.equal(alphaAt(X0 + 700), 0);
  });

  it('gives the same picture whatever order the photos are listed in', () => {
    const swapped = mosaicRaster({ ...req, frames: [req.frames[1]!, req.frames[0]!] });
    assert.ok(swapped.data.every((v, i) => Math.abs(v - r.data[i]!) <= 1));
  });
});

describe('mosaicRaster: which photo wins', () => {
  // Two photos over the same ground, one from twice as high (a photo pixel is 0.3 ft, not 0.15). The output has
  // 0.2 ft pixels, so the low photo has more pixels than the screen (fine) and the high one fewer (blurry).
  const tiny = { corners: box(X0 - 4, X0 + 4, Y0 - 3, Y0 + 3), width: 40, height: 30 };

  it('prefers the sharper photo where they overlap', () => {
    const r = mosaicRaster({ ...tiny, frames: [frame(X0, [255, 0, 0], {}, 3000), frame(X0, [0, 0, 255], {}, 6000)] });
    const [cr, , cb, ca] = at(r, 20, 15);
    assert.ok(cr > 190 && cb < 65 && ca === 255, `${cr},${cb},${ca}`);
  });

  it('still draws a blurry photo in full when it is the only one', () => {
    const r = mosaicRaster({ ...tiny, frames: [frame(X0, [0, 0, 255], {}, 6000)] });
    assert.deepEqual(at(r, 20, 15), [0, 0, 255, 255]);
  });

  it('favours the photo the user chose, when the two are equally good', () => {
    const equal = { ...tiny, width: 8, height: 6, corners: box(X0 - 100, X0 + 100, Y0 - 75, Y0 + 75) }; // 25 ft pixels: both photos have far more pixels
    const plain = mosaicRaster({ ...equal, frames: [frame(X0, [255, 0, 0]), frame(X0, [0, 0, 255])] });
    const [pr, , pb] = at(plain, 4, 3);
    assert.ok(Math.abs(pr - pb) <= 2, 'equal: an even mix');
    const chosen = mosaicRaster({ ...equal, frames: [frame(X0, [255, 0, 0]), frame(X0, [0, 0, 255], { bias: 1.5 })] });
    const [cr, , cb] = at(chosen, 4, 3);
    assert.ok(cb > 190 && cr < 65, `${cr},${cb}`);
  });

  it('is clear where there are no photos', () => {
    const r = mosaicRaster({ ...tiny, frames: [] });
    assert.ok(r.data.every((v) => v === 0));
  });

  it('is clear where a photo does not reach the ground asked for', () => {
    const r = mosaicRaster({ corners: box(X0 + 5000, X0 + 5010, Y0, Y0 + 8), width: 10, height: 8, frames: [frame(X0, [255, 0, 0])] });
    assert.ok(r.data.every((v) => v === 0));
  });

  it('does not draw where the tiles that were read do not cover the ground', () => {
    // a source that covers only the left half of the photo's columns
    const half = frame(X0, [255, 0, 0], { source: { ...solid(255, 0, 0), width: 20 } });
    const r = mosaicRaster({ corners: box(X0 - 250, X0 + 250, Y0 - 100, Y0 + 100), width: 50, height: 20, frames: [half] });
    assert.equal(at(r, 10, 10)[3], 255); // left of the middle: inside the source
    assert.equal(at(r, 40, 10)[3], 0); // right of the middle: beyond it
  });
});

describe('mosaicRaster with one real photo', () => {
  it('matches the single-photo warp everywhere in the middle', () => {
    const frames = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
    const f = frames.find((x: { camera: string }) => x.camera === 'Bwd');
    const cam = createCamera(f.eo, f.sensor);
    const z = f.footprint3089.slice(0, 4).reduce((s: number, p: number[]) => s + p[2]!, 0) / 4;
    const [cx, cy] = cam.pixelToGround(cam.widthPx / 2, cam.heightPx / 2, z)!;
    const corners = box(cx - 150, cx + 150, cy - 110, cy + 110);
    const source: Raster = (() => { const w = 128, h = 96, data = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; data[o] = x * 2; data[o + 1] = y * 2; data[o + 2] = (x + y) % 256; data[o + 3] = 255; } return { width: w, height: h, data }; })();
    const sx = 128 / cam.widthPx, sy = 96 / cam.heightPx;
    const one = orthoRaster({ corners, width: 60, height: 44, camera: cam, heightAt: () => z, source, toSource: (c, r) => [c * sx, r * sy] });
    const mos = mosaicRaster({ corners, width: 60, height: 44, frames: [{ camera: cam, heightAt: () => z, source, scaleX: sx, scaleY: sy, offsetX: 0, offsetY: 0 }] });
    let checked = 0;
    for (let y = 5; y < 39; y++) for (let x = 5; x < 55; x++) {
      const a = at(one, x, y), b = at(mos, x, y);
      if (a[3] === 0) continue;
      checked++;
      assert.ok(Math.abs(a[0]! - b[0]!) <= 1 && Math.abs(a[1]! - b[1]!) <= 1 && Math.abs(a[2]! - b[2]!) <= 1 && b[3] === 255, `${x},${y}: ${a} vs ${b}`);
    }
    assert.ok(checked > 1500, `${checked} pixels compared`);
  });
});
