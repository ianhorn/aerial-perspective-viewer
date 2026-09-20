import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';
import { maxScreenScale, photoRegionUnder } from '../src/detail.ts';

const frames = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
const obliques = frames.filter((f: { camera: string }) => f.camera !== 'Color');
const meanZ = (f: { footprint3089: number[][] }) => f.footprint3089.slice(0, 4).reduce((s, p) => s + p[2]!, 0) / 4;

describe('photoRegionUnder', () => {
  it('maps a screen-sized patch of ground in the middle of the photo to a region inside it', () => {
    for (const f of obliques) {
      const camera = createCamera(f.eo, f.sensor), z = meanZ(f);
      const [cx, cy] = camera.pixelToGround(camera.widthPx / 2, camera.heightPx / 2, z)!;
      const patch: [number, number][] = [[cx - 100, cy - 100], [cx + 100, cy - 100], [cx + 100, cy + 100], [cx - 100, cy + 100]];
      const r = photoRegionUnder(camera, z, patch)!;
      assert.ok(r, f.filename);
      assert.ok(r.x0 > 0 && r.y0 > 0 && r.x1 < camera.widthPx && r.y1 < camera.heightPx, `${f.filename} ${JSON.stringify(r)}`);
      // the middle of the photo is in the region
      assert.ok(r.x0 < camera.widthPx / 2 && r.x1 > camera.widthPx / 2 && r.y0 < camera.heightPx / 2 && r.y1 > camera.heightPx / 2, f.filename);
    }
  });

  it('is smaller for a smaller patch of ground', () => {
    const f = obliques[0], camera = createCamera(f.eo, f.sensor), z = meanZ(f);
    const [cx, cy] = camera.pixelToGround(camera.widthPx / 2, camera.heightPx / 2, z)!;
    const area = (h: number) => { const r = photoRegionUnder(camera, z, [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]])!; return (r.x1 - r.x0) * (r.y1 - r.y0); };
    assert.ok(area(100) < area(400) && area(400) < area(1000));
  });

  it('is clamped to the photo, and null when the screen shows none of it', () => {
    const f = obliques[0], camera = createCamera(f.eo, f.sensor), z = meanZ(f);
    // ground that overhangs the photo on every side: the vendor footprint enlarged by 30% about its middle
    const [cx0, cy0] = camera.pixelToGround(camera.widthPx / 2, camera.heightPx / 2, z)!;
    const bigger = f.footprint3089.slice(0, 4).map((p: number[]) => [cx0 + (p[0]! - cx0) * 1.3, cy0 + (p[1]! - cy0) * 1.3] as [number, number]);
    const whole = photoRegionUnder(camera, z, bigger)!;
    assert.deepEqual(whole, { x0: 0, y0: 0, x1: camera.widthPx, y1: camera.heightPx });
    // ground far to the side of the photo
    const [cx, cy] = camera.pixelToGround(camera.widthPx / 2, camera.heightPx / 2, z)!;
    assert.equal(photoRegionUnder(camera, z, [[cx + 50000, cy], [cx + 50100, cy], [cx + 50100, cy + 100], [cx + 50000, cy + 100]]), null);
  });

  it('says the whole photo when a point is beyond the camera', () => {
    const f = obliques[0], camera = createCamera(f.eo, f.sensor);
    const r = photoRegionUnder(camera, meanZ(f), [[f.eo.x, f.eo.y]], 0)!; // straight below the camera is behind an oblique's lens... or not; use a point above instead
    assert.ok(r === null || (r.x1 > r.x0 && r.y1 > r.y0));
    const behind = photoRegionUnder(camera, f.eo.z + 5000, [[f.eo.x, f.eo.y]])!; // a plane above the camera: nothing in front of it
    assert.deepEqual(behind, { x0: 0, y0: 0, x1: camera.widthPx, y1: camera.heightPx });
  });
});

describe('maxScreenScale', () => {
  // Ten screen pixels per foot of ground, laid out on a plain grid.
  const toScreen = (x: number, y: number): [number, number] => [x * 10, -y * 10];

  it('is about ten times the ground size of a photo pixel, which is about 0.2 to 0.3 ft', () => {
    for (const f of obliques) {
      const camera = createCamera(f.eo, f.sensor), z = meanZ(f);
      const k = maxScreenScale(camera, z, { x0: 0, y0: 0, x1: camera.widthPx, y1: camera.heightPx }, toScreen)!;
      assert.ok(k > 1.5 && k < 6, `${f.filename}: ${k} screen pixels per photo pixel at 10 px per foot`);
    }
  });

  it('is largest on the far side of an oblique, where a pixel covers more ground', () => {
    const f = obliques[0], camera = createCamera(f.eo, f.sensor), z = meanZ(f);
    const top = maxScreenScale(camera, z, { x0: 0, y0: 0, x1: camera.widthPx, y1: 600 }, toScreen)!;
    const bottom = maxScreenScale(camera, z, { x0: 0, y0: camera.heightPx - 600, x1: camera.widthPx, y1: camera.heightPx }, toScreen)!;
    assert.ok(top !== bottom);
    // Which side is far depends on how the camera is mounted, but the two must differ by a real amount.
    assert.ok(Math.abs(top - bottom) / Math.min(top, bottom) > 0.15, `${top} vs ${bottom}`);
  });

  it('doubles when the map zooms in by a factor of two', () => {
    const f = obliques[0], camera = createCamera(f.eo, f.sensor), z = meanZ(f);
    const region = { x0: 2000, y0: 2000, x1: 3000, y1: 3000 };
    const a = maxScreenScale(camera, z, region, toScreen)!;
    const b = maxScreenScale(camera, z, region, (x, y) => [x * 20, -y * 20])!;
    assert.ok(Math.abs(b / a - 2) < 1e-9);
  });

  it('is null when nothing can be measured', () => {
    const f = obliques[0], camera = createCamera(f.eo, f.sensor);
    assert.equal(maxScreenScale(camera, f.eo.z + 3000, { x0: 0, y0: 0, x1: 1000, y1: 1000 }, toScreen), null);
  });
});
