import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';
import { lonLatToGrid } from '../src/lcc.ts';
import { bearingBetween, flightHeading, gridBearingToTrue, meanGroundHeight, photoCorners, upBearing } from '../src/scene.ts';

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

describe('flightHeading', () => {
  it('turns a look direction into the direction of flight', () => {
    assert.ok(Math.abs(flightHeading('Fwd', 359.7)! - 359.7) < 1e-9); // Fwd looks where it flies
    assert.ok(Math.abs(flightHeading('Bwd', 0.54)! - 180.54) < 1e-9); // Bwd looks back; the real frame's ground track was 180.63
    assert.equal(flightHeading('Left', 90), 180); // flying south, the left side is east
    assert.equal(flightHeading('Right', 270), 180); // flying south, the right side is west
  });

  it('wraps into 0 to 360', () => {
    assert.equal(flightHeading('Bwd', 200), 20);
    assert.equal(flightHeading('Left', 300), 30);
    assert.equal(flightHeading('Right', 10), 280);
  });

  it('uses the ground track for Color, and says null when nothing is known', () => {
    assert.equal(flightHeading('Color', null, 123.4), 123.4);
    assert.equal(flightHeading('Color', null), null);
    assert.equal(flightHeading('Fwd', null), null);
  });

  it('agrees with the aircraft track of a real frame in every fixture', () => {
    // The camera's look direction and the flight direction it implies must differ by exactly its offset.
    for (const f of obliques) {
      const heading = flightHeading(f.camera, f.lookAzimuth)!;
      const offset = { Fwd: 0, Bwd: 180, Left: -90, Right: 90 }[f.camera as 'Fwd' | 'Bwd' | 'Left' | 'Right'];
      assert.ok(angleDiff(heading + offset, f.lookAzimuth) < 1e-9, f.filename);
    }
  });
});

describe('gridBearingToTrue', () => {
  it('is the same on the central meridian, where grid north is true north', () => {
    const [x, y] = lonLatToGrid(-85.75, 38);
    // bearingBetween is spherical and the projection is on the ellipsoid, which differ by up to about 0.14 degrees
    // at 45 degrees (the north-south and east-west scales differ by 0.5%). Far below what an icon can show.
    for (const b of [0, 45, 90, 180, 270]) assert.ok(angleDiff(gridBearingToTrue(x, y, b), b) < 0.3, `${b}`);
    for (const b of [0, 90, 180, 270]) assert.ok(angleDiff(gridBearingToTrue(x, y, b), b) < 0.01, `${b} exactly`);
  });

  it('differs by the grid convergence away from it: about -2.4 degrees at the west edge, +2.4 at the east', () => {
    const [xw, yw] = lonLatToGrid(-89.5, 37);
    const [xe, ye] = lonLatToGrid(-82, 37.5);
    // A bearing of 0 in grid is a little west of true north in the west of the zone... the sign is what the projection says.
    const west = gridBearingToTrue(xw, yw, 0), east = gridBearingToTrue(xe, ye, 0);
    const signed = (v: number) => ((v + 540) % 360) - 180;
    assert.ok(Math.abs(signed(west)) > 1.5 && Math.abs(signed(west)) < 2.6, `west ${signed(west).toFixed(2)}`);
    assert.ok(Math.abs(signed(east)) > 1.2 && Math.abs(signed(east)) < 2.6, `east ${signed(east).toFixed(2)}`);
    assert.ok(signed(west) * signed(east) < 0, 'opposite signs on the two sides of the central meridian');
  });

  it('keeps the shape of the turn: 90 degrees of grid is still about 90 degrees of true', () => {
    const [x, y] = lonLatToGrid(-84, 38);
    assert.ok(angleDiff(gridBearingToTrue(x, y, 90), 90) < 3);
  });
});
