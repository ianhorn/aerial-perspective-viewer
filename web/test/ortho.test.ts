import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';
import { gridToLonLat, lonLatToGrid } from '../src/lcc.ts';
import { lonLatToWorld, worldToLonLat } from '../src/mercator.ts';
import { buildMesh, orthoRaster, type Raster, warp } from '../src/ortho.ts';

const frames = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
const obliques = frames.filter((f: { camera: string }) => f.camera !== 'Color');

/** A raster where every pixel's colour says where it is: R and G are its column and row in 0..255 of the width and height. */
function coordinates(w: number, h: number): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; data[o] = (x / (w - 1)) * 255; data[o + 1] = (y / (h - 1)) * 255; data[o + 2] = 0; data[o + 3] = 255; }
  return { width: w, height: h, data };
}

describe('mercator', () => {
  it('goes there and back', () => {
    for (const [lon, lat] of [[-85.72, 38.24], [-89.5, 36.6], [-82, 39.1], [0, 0]] as const) {
      const [x, y] = lonLatToWorld(lon, lat);
      const [lo, la] = worldToLonLat(x, y);
      assert.ok(Math.abs(lo - lon) < 1e-9 && Math.abs(la - lat) < 1e-9);
    }
  });
  it('puts the equator and the date line where the standard layout does', () => {
    assert.deepEqual(lonLatToWorld(0, 0), [0.5, 0.5]);
    assert.ok(Math.abs(lonLatToWorld(-180, 0)[0]) < 1e-12);
    assert.ok(lonLatToWorld(-85, 39)[1] < lonLatToWorld(-85, 38)[1]); // y grows southward
  });
});

describe('warp', () => {
  it('copies a picture through an identity trace', () => {
    const src = coordinates(64, 48);
    const mesh = buildMesh(64, 48, 16, (x, y) => [x, y]);
    const out = warp(src, mesh, 64, 48);
    for (const [x, y] of [[0, 0], [10, 7], [63, 47], [31, 20]]) {
      const o = (y! * 64 + x!) * 4;
      assert.ok(Math.abs(out.data[o]! - src.data[o]!) <= 1 && Math.abs(out.data[o + 1]! - src.data[o + 1]!) <= 1, `${x},${y}`);
      assert.equal(out.data[o + 3], 255);
    }
  });

  it('reads the source at the traced position: a shift of 10 columns', () => {
    const src = coordinates(100, 20);
    const out = warp(src, buildMesh(50, 20, 10, (x, y) => [x + 10, y]), 50, 20);
    const o = (5 * 50 + 20) * 4; // output pixel 20, whose centre 20.5 traces to 30.5, source pixel 30
    assert.ok(Math.abs(out.data[o]! - (30 / 99) * 255) < 1.5);
  });

  it('leaves pixels transparent that trace outside the source, or nowhere', () => {
    const src = coordinates(40, 40);
    const out = warp(src, buildMesh(40, 40, 8, (x, y) => (x > 30 ? null : [x + 20, y])), 40, 40);
    assert.equal(out.data[(5 * 40 + 5) * 4 + 3], 255); // traces to 25.5: inside
    assert.equal(out.data[(5 * 40 + 25) * 4 + 3], 0); // traces to 45.5: outside
    assert.equal(out.data[(5 * 40 + 38) * 4 + 3], 0); // no answer
  });

  it('blends the four nearest source pixels', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 200, 0, 0, 255, 0, 0, 0, 255, 200, 0, 0, 255]); // 2 x 2: dark, bright / dark, bright
    const out = warp({ width: 2, height: 2, data }, buildMesh(1, 1, 1, () => [1, 1]), 1, 1); // the middle, between all four
    assert.equal(Math.round(out.data[0]!), 100);
  });
});

describe('orthoRaster', () => {
  const meanZ = (f: typeof obliques[number]) => f.footprint3089.slice(0, 4).reduce((s: number, p: number[]) => s + p[2]!, 0) / 4;
  // A square of ground, 300 ft across, centred on what the photo's middle sees on flat ground at the mean height.
  const area = (f: typeof obliques[number]) => {
    const camera = createCamera(f.eo, f.sensor);
    const [cx, cy] = camera.pixelToGround(camera.widthPx / 2, camera.heightPx / 2, meanZ(f))!;
    return { camera, cx, cy, half: 150 };
  };
  // The picture of that ground made from a source whose colours say which photo pixel they are.
  const setup = (f: typeof obliques[number], heightAt: (x: number, y: number) => number) => {
    const { camera, cx, cy, half } = area(f);
    const corners = [[cx - half, cy + half], [cx + half, cy + half], [cx + half, cy - half], [cx - half, cy - half]].map(([x, y]) => gridToLonLat(x!, y!)) as [[number, number], [number, number], [number, number], [number, number]];
    const source = coordinates(256, 256);
    const raster = orthoRaster({ corners, width: 96, height: 96, camera, heightAt, source, toSource: (c, r) => [(c / camera.widthPx) * 256, (r / camera.heightPx) * 256], step: 8 });
    return { camera, corners, raster, cx, cy, half };
  };

  it('samples each output pixel from the photo pixel where the camera sees that ground', () => {
    for (const f of obliques) {
      const z = meanZ(f);
      const { camera, raster, cx, cy, half } = setup(f, () => z);
      for (const [px, py] of [[10, 10], [48, 48], [85, 20], [30, 80]] as const) {
        // the ground at this output pixel, in grid feet (the picture is spread evenly in Mercator, near enough to plain over 300 ft to test to a pixel)
        const gx = cx - half + ((px + 0.5) / 96) * 2 * half, gy = cy + half - ((py + 0.5) / 96) * 2 * half;
        const seen = camera.groundToPixel(gx, gy, z)!;
        const o = (py * 96 + px) * 4;
        assert.equal(raster.data[o + 3], 255, `${f.filename} ${px},${py}`);
        const gotCol = (raster.data[o]! / 255) * camera.widthPx, gotRow = (raster.data[o + 1]! / 255) * camera.heightPx;
        // colours are 8 bits over a 256 px source: a photo pixel is 40 to 55 source pixels, so allow a few hundred photo pixels
        const tolerance = (camera.widthPx / 255) * 2.5;
        assert.ok(Math.abs(gotCol - seen[0]) < tolerance && Math.abs(gotRow - seen[1]) < (camera.heightPx / 255) * 2.5, `${f.filename} ${px},${py}: got ${gotCol.toFixed(0)},${gotRow.toFixed(0)} want ${seen[0].toFixed(0)},${seen[1].toFixed(0)}`);
      }
    }
  });

  it('moves the picture when the ground is higher: a hill shifts the sampled position', () => {
    const f = obliques[0];
    const z = meanZ(f);
    const flat = setup(f, () => z);
    const hill = setup(f, () => z + 80); // the same ground, 80 ft higher
    const o = (48 * 96 + 48) * 4;
    const d = Math.hypot(flat.raster.data[o]! - hill.raster.data[o]!, flat.raster.data[o + 1]! - hill.raster.data[o + 1]!);
    assert.ok(d > 3, `an 80 ft rise moved the sampled colour by only ${d}`);
  });

  it('is transparent where the ground is outside the photo', () => {
    const f = obliques[0];
    const { camera, cx, cy } = area(f);
    const z = meanZ(f);
    const far = [[cx + 40000, cy + 100], [cx + 40200, cy + 100], [cx + 40200, cy - 100], [cx + 40000, cy - 100]].map(([x, y]) => gridToLonLat(x!, y!)) as [[number, number], [number, number], [number, number], [number, number]];
    const r = orthoRaster({ corners: far, width: 16, height: 16, camera, heightAt: () => z, source: coordinates(8, 8), toSource: (c, rr) => [c / 100, rr / 100], step: 8 });
    assert.ok([...r.data].filter((_, i) => i % 4 === 3).every((a) => a === 0));
  });

  it('round-trips a grid position through lon/lat, as the trace does', () => {
    const [x, y] = lonLatToGrid(...gridToLonLat(4930650, 3968750));
    assert.ok(Math.abs(x - 4930650) < 1e-3 && Math.abs(y - 3968750) < 1e-3);
  });
});
