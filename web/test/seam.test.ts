import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';

// Why the scene lays every photo on one shared flat plane: two photos of the same hillside, each laid on its own
// plane, put a point of ground in two different places (the seam), by about the difference of the planes' heights.
// On one shared plane they agree wherever the ground is near that plane's height.
const frames = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
const oblique = frames.find((f: { camera: string }) => f.camera === 'Bwd');

/** Where a photo puts the ground point (x, y, z) when it is laid on the flat plane at height `plane`. */
function landing(camera: ReturnType<typeof createCamera>, x: number, y: number, z: number, plane: number): [number, number] {
  const pixel = camera.groundToPixel(x, y, z)!;
  return camera.pixelToGround(pixel[0], pixel[1], plane)!;
}

describe('seams between photos laid on flat ground', () => {
  // Two exposures of the same view, 400 ft apart along the flight line, looking the same way.
  const a = createCamera(oblique.eo, oblique.sensor);
  const b = createCamera({ ...oblique.eo, x: oblique.eo.x + 400 }, oblique.sensor);
  // The ground at the middle of the picture, where the hillside is 700 ft high.
  const ground = a.pixelToGround(a.widthPx / 2, a.heightPx / 2, 700)!;
  const seam = (heightA: number, heightB: number, z: number): number => {
    const [ax, ay] = landing(a, ground[0], ground[1], z, heightA);
    const [bx, by] = landing(b, ground[0], ground[1], z, heightB);
    return Math.hypot(ax - bx, ay - by);
  };

  it('agree exactly on ground at the shared plane\'s height', () => {
    assert.ok(seam(700, 700, 700) < 1e-6);
  });

  it('agree to a few feet on ground 60 ft off the shared plane', () => {
    assert.ok(seam(700, 700, 760) < 10, `${seam(700, 700, 760)} ft`);
    assert.ok(seam(700, 700, 640) < 10, `${seam(700, 700, 640)} ft`);
  });

  it('disagree by about the difference in height when each photo has its own plane', () => {
    const own = seam(560, 620, 700); // their footprints' mean heights differ by 60 ft
    assert.ok(own > 40, `${own} ft`);
    assert.ok(own > 5 * seam(700, 700, 760), 'own planes are far worse than one shared plane');
  });
});
