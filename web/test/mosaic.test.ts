import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';
import { gridToLonLat } from '../src/lcc.ts';
import { edgeWeight, type MosaicFrame, mosaicRaster, neededFrames } from '../src/mosaic.ts';
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
  // A covers x from X0-300 to X0+300 and B from X0+60 to X0+660, so they overlap from X0+60 to X0+300. A is listed first, so it is on top.
  const req = { corners: box(X0 - 350, X0 + 710, Y0 - 225, Y0 + 225), width: 212, height: 90, frames: [frame(X0, [255, 0, 0]), frame(X0 + 360, [0, 0, 255])] };
  const r = mosaicRaster(req);
  const px = (groundX: number) => Math.floor((groundX - (X0 - 350)) / 5); // the output pixel that ground x falls in (5 ft per pixel; its middle is 2.5 ft further on)

  it('shows each photo where only it reaches', () => {
    assert.deepEqual(at(r, px(X0 - 200), 45), [255, 0, 0, 255]);
    assert.deepEqual(at(r, px(X0 + 500), 45), [0, 0, 255, 255]);
  });

  it('shows only the top photo where both reach: one photo, never a mix, so nothing can ghost', () => {
    for (const g of [70, 100, 180, 250]) {
      assert.deepEqual(at(r, px(X0 + g), 45), [255, 0, 0, 255], `${g} ft in`);
    }
  });

  it('lets the photo below show past the top one\'s edge, through a short blend', () => {
    // A's edge is at X0+300 and it fades over 9 ft (2% of its shorter side: 60 photo pixels of 0.15 ft). The output pixel
    // at X0+297.5 is 2.5 ft inside the edge: about a fifth of it is A, four fifths the photo below.
    const [nr, , nb, na] = at(r, px(X0 + 297.5), 45);
    assert.ok(nr > 20 && nr < 90 && nb > 165 && nb < 235 && na === 255, `${nr},${nb},${na}`);
    // 7.5 ft inside the edge it is nearly all A, and 12.5 ft inside it is all A.
    const [ir, , ib] = at(r, px(X0 + 292.5), 45);
    assert.ok(ir > 235 && ib < 20, `${ir},${ib}`);
    assert.deepEqual(at(r, px(X0 + 287.5), 45), [255, 0, 0, 255]);
    // past the edge: B alone
    assert.deepEqual(at(r, px(X0 + 307.5), 45), [0, 0, 255, 255]);
  });

  it('goes from the top photo to the one below in one narrow step, not across the overlap', () => {
    const across = [] as number[];
    for (let g = 60; g <= 330; g += 5) across.push(at(r, px(X0 + g), 45)[0]!);
    const changing = across.filter((v) => v > 5 && v < 250).length;
    assert.ok(changing <= 3, `${changing} of ${across.length} samples were part way`); // only the band at A's edge
    for (let k = 1; k < across.length; k++) assert.ok(across[k]! <= across[k - 1]! + 1, 'red never comes back');
  });

  it('fades out at the edge of a photo where nothing else reaches, and is clear beyond', () => {
    const alphaAt = (g: number) => at(r, px(g), 45)[3]!;
    assert.ok(alphaAt(X0 - 297.5) > 20 && alphaAt(X0 - 297.5) < 90, `${alphaAt(X0 - 297.5)}`); // 2.5 ft inside A's edge: about a fifth
    assert.equal(alphaAt(X0 - 200), 255);
    assert.equal(alphaAt(X0 - 340), 0);
    assert.equal(alphaAt(X0 + 700), 0);
  });

  it('puts whichever photo is listed first on top', () => {
    const swapped = mosaicRaster({ ...req, frames: [req.frames[1]!, req.frames[0]!] });
    assert.deepEqual(at(swapped, px(X0 + 180), 45), [0, 0, 255, 255]); // B now wins the overlap
    assert.deepEqual(at(swapped, px(X0 - 200), 45), [255, 0, 0, 255]); // A alone is unchanged
  });
});

describe('mosaicRaster: what is drawn', () => {
  const tiny = { corners: box(X0 - 4, X0 + 4, Y0 - 3, Y0 + 3), width: 40, height: 30 };

  it('draws a blurry photo in full when it is the only one (sharpness does not fade a photo)', () => {
    const r = mosaicRaster({ ...tiny, frames: [frame(X0, [0, 0, 255], {}, 6000)] });
    assert.deepEqual(at(r, 20, 15), [0, 0, 255, 255]);
  });

  it('is clear where there are no photos', () => {
    const r = mosaicRaster({ ...tiny, frames: [] });
    assert.ok(r.data.every((v) => v === 0));
  });

  it('is clear where a photo does not reach the ground asked for', () => {
    const r = mosaicRaster({ corners: box(X0 + 5000, X0 + 5010, Y0, Y0 + 8), width: 10, height: 8, frames: [frame(X0, [255, 0, 0])] });
    assert.ok(r.data.every((v) => v === 0));
  });

  it('falls through to the next photo where the top one\'s tiles do not cover the ground', () => {
    // the top photo has read only the left half of its columns; the one below is whole
    const half = frame(X0, [255, 0, 0], { source: { ...solid(255, 0, 0), width: 20 } });
    const below = frame(X0, [0, 0, 255]);
    const r = mosaicRaster({ corners: box(X0 - 250, X0 + 250, Y0 - 100, Y0 + 100), width: 50, height: 20, frames: [half, below] });
    assert.deepEqual(at(r, 10, 10), [255, 0, 0, 255]); // left of the middle: the top photo
    assert.deepEqual(at(r, 40, 10), [0, 0, 255, 255]); // right of the middle: beyond its tiles, so the photo below
  });

  it('does not read a photo that is hidden by the ones above it (the time saved)', () => {
    // A photo whose pixels are not there to be read does not matter where the top one covers: no exception, same picture.
    const top = frame(X0, [255, 0, 0]);
    const broken = { ...frame(X0, [0, 0, 255]), source: { width: 1, height: 1, data: new Uint8ClampedArray(4) } };
    const a = mosaicRaster({ ...tiny, frames: [top] }), b = mosaicRaster({ ...tiny, frames: [top, broken] });
    assert.ok(a.data.every((v, i) => v === b.data[i]));
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

describe('neededFrames', () => {
  // Three photos 600 ft wide over the same row: A centred at X0, B at X0+360, C at X0+720. Ground points along the row.
  const cams = (xs: number[]) => xs.map((x) => ({ camera: camera(x), heightAt: () => 0 }));
  const row = (from: number, to: number, n = 9): [number, number][] => Array.from({ length: n }, (_, i) => [X0 + from + ((to - from) * i) / (n - 1), Y0] as [number, number]);

  it('needs only the top photo when it covers the whole view', () => {
    assert.deepEqual(neededFrames(cams([X0, X0 + 360, X0 + 720]), row(-100, 100)), [true, false, false]);
  });

  it('needs the next photo once the view runs past the top photo', () => {
    assert.deepEqual(neededFrames(cams([X0, X0 + 360, X0 + 720]), row(0, 500)), [true, true, false]);
    assert.deepEqual(neededFrames(cams([X0, X0 + 360, X0 + 720]), row(0, 800)), [true, true, true]);
  });

  it('needs the next photo where the top one only fades out, and not one that adds nothing new', () => {
    // A's edge at X0+300, and the view stops just inside it, in the fade band (the last 9 ft)
    assert.deepEqual(neededFrames(cams([X0, X0 + 360]), row(200, 298)), [true, true]);
    assert.deepEqual(neededFrames(cams([X0, X0 + 360]), row(200, 280)), [true, false]);
  });

  it('follows the priority order: a photo listed first is judged first', () => {
    assert.deepEqual(neededFrames(cams([X0 + 360, X0]), row(100, 200)), [true, false]); // B first: it covers 100..200 alone
  });

  it('needs nothing that does not reach the view, and says false for all when there are no points', () => {
    assert.deepEqual(neededFrames(cams([X0 + 5000]), row(0, 100)), [false]);
    assert.deepEqual(neededFrames(cams([X0]), []), [false]);
  });

  it('edgeWeight is 0 outside a photo, 0 at its edge, and 1 well inside', () => {
    assert.equal(edgeWeight(-1, 100, 4000, 3000), 0);
    assert.equal(edgeWeight(0, 100, 4000, 3000), 0);
    assert.equal(edgeWeight(2000, 1500, 4000, 3000), 1);
    assert.ok(edgeWeight(30, 1500, 4000, 3000) > 0 && edgeWeight(30, 1500, 4000, 3000) < 1);
  });
});
