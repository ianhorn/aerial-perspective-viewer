import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';
import { lonLatToGrid } from '../src/lcc.ts';
import { bearingBetween, meanGroundHeight, photoCorners, upBearing } from '../src/scene.ts';

const frames = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
const obliques = frames.filter((f: { camera: string }) => f.camera !== 'Color');
const angleDiff = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('bearingBetween', () => {
  it('gives the compass points', () => {
    assert.ok(Math.abs(bearingBetween([-85, 38], [-85, 39]) - 0) < 1e-9);
    assert.ok(Math.abs(bearingBetween([-85, 38], [-84, 38]) - 90) < 0.5);
    assert.ok(Math.abs(bearingBetween([-85, 38], [-85, 37]) - 180) < 1e-9);
    assert.ok(Math.abs(bearingBetween([-85, 38], [-86, 38]) - 270) < 0.5);
  });
});

describe('photo placement', () => {
  it('puts the corners of an oblique on its vendor footprint, off only by what the terrain does', () => {
    for (const f of obliques) {
      const corners = photoCorners(createCamera(f.eo, f.sensor), meanGroundHeight(f.footprint3089))!;
      assert.ok(corners, f.filename);
      const heights = f.footprint3089.slice(0, 4).map((p: number[]) => p[2]!);
      const relief = Math.max(...heights) - Math.min(...heights);
      corners.forEach((corner, i) => {
        const [x, y] = lonLatToGrid(corner[0], corner[1]);
        const off = Math.hypot(x - f.footprint3089[i][0], y - f.footprint3089[i][1]);
        // The vendor footprint follows the terrain and the drape is flat. A height error of dz moves a point
        // sideways by dz / tan(angle above the horizon), about 1 to 1.5 dz over these views.
        assert.ok(off <= 1.5 * relief + 40, `${f.filename} corner ${i}: ${off.toFixed(0)} ft off with ${relief.toFixed(0)} ft of relief`);
      });
    }
  });

  it('points the top of an oblique the way it looks, within the grid-to-true-north difference', () => {
    for (const f of obliques) {
      const bearing = upBearing(createCamera(f.eo, f.sensor), meanGroundHeight(f.footprint3089))!;
      assert.ok(angleDiff(bearing, f.lookAzimuth) < 3.5, `${f.filename}: up is ${bearing.toFixed(1)}, look azimuth ${f.lookAzimuth}`);
    }
  });

  it('is null when the corners cannot reach the ground', () => {
    const f = obliques[0];
    const camera = createCamera(f.eo, f.sensor);
    assert.equal(photoCorners(camera, f.eo.z + 500), null);
    assert.equal(upBearing(camera, f.eo.z + 500), null);
  });
});
