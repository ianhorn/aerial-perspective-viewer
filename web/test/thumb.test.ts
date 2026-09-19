import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { createCamera } from '../src/camera.ts';
import { cropAround, fitInside } from '../src/thumb.ts';

describe('fitInside', () => {
  it('scales a landscape photo to the width of the box', () => {
    assert.deepEqual(fitInside(1287, 962, 96, 72), { width: 96, height: 72 });
    assert.deepEqual(fitInside(442, 330, 192, 144), { width: 192, height: 143 });
  });

  it('scales a portrait photo to the height of the box', () => {
    assert.deepEqual(fitInside(330, 442, 96, 72), { width: 54, height: 72 });
    assert.deepEqual(fitInside(241, 322, 96, 72), { width: 54, height: 72 });
  });

  it('never enlarges a small picture', () => {
    assert.deepEqual(fitInside(60, 40, 96, 72), { width: 60, height: 40 });
  });

  it('never returns a zero side', () => {
    assert.deepEqual(fitInside(10000, 10, 96, 72), { width: 96, height: 1 });
  });
});

const frames = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
const obliques = frames.filter((f: { camera: string }) => f.camera !== 'Color');
const meanZ = (f: { footprint3089: number[][] }) => f.footprint3089.slice(0, 4).reduce((s, p) => s + p[2]!, 0) / 4;

describe('cropAround', () => {
  it('centres on the point when it is well inside the photo, and puts the marker in the middle', () => {
    for (const f of obliques) {
      const camera = createCamera(f.eo, f.sensor), z = meanZ(f);
      const [x, y] = camera.pixelToGround(camera.widthPx / 2, camera.heightPx / 2, z)!;
      const c = cropAround(camera, { x, y, z })!;
      assert.ok(Math.abs(c.markerX - 0.5) < 1e-6 && Math.abs(c.markerY - 0.5) < 1e-6, f.filename);
      assert.ok(Math.abs(c.width / c.height - 4 / 3) < 1e-6, 'not stretched');
      assert.ok(Math.abs(c.groundWidthFt - 250) < 1, `${f.filename}: ${c.groundWidthFt} ft across`);
    }
  });

  it('covers about 250 ft of ground whatever the photo, so its size in photo pixels differs', () => {
    const sizes = obliques.map((f: typeof obliques[number]) => { const camera = createCamera(f.eo, f.sensor); const z = meanZ(f); const [x, y] = camera.pixelToGround(camera.widthPx / 2, camera.heightPx / 2, z)!; return cropAround(camera, { x, y, z })!.width; });
    assert.ok(Math.max(...sizes) > Math.min(...sizes) * 1.05, sizes.join(', '));
    for (const w of sizes) assert.ok(w > 700 && w < 1800, `${w}`); // about 0.2 to 0.3 ft per pixel
  });

  it('stays inside the photo when the point is near an edge, with the marker off centre', () => {
    const f = obliques[0], camera = createCamera(f.eo, f.sensor), z = meanZ(f);
    const [x, y] = camera.pixelToGround(200, 150, z)!; // near the top left corner of the picture
    const c = cropAround(camera, { x, y, z })!;
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= camera.widthPx + 1e-6 && c.y + c.height <= camera.heightPx + 1e-6);
    assert.equal(c.x, 0);
    assert.equal(c.y, 0);
    assert.ok(c.markerX < 0.3 && c.markerY < 0.3, `${c.markerX}, ${c.markerY}`);
  });

  it('puts the marker where the camera sees the point', () => {
    const f = obliques[1], camera = createCamera(f.eo, f.sensor), z = meanZ(f);
    const [x, y] = camera.pixelToGround(camera.widthPx * 0.7, camera.heightPx * 0.4, z)!;
    const c = cropAround(camera, { x, y, z })!;
    assert.ok(Math.abs(c.x + c.markerX * c.width - camera.widthPx * 0.7) < 0.5 && Math.abs(c.y + c.markerY * c.height - camera.heightPx * 0.4) < 0.5);
  });

  it('is null when the camera cannot see the point', () => {
    const f = obliques[0], camera = createCamera(f.eo, f.sensor);
    assert.equal(cropAround(camera, { x: f.eo.x, y: f.eo.y, z: f.eo.z + 4000 }), null);
  });
});
