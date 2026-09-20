import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';
import { cropFor, GROUND_FT_PER_THUMB_PX } from '../src/thumb-crop.ts';
import { meanGroundHeight } from '../src/scene.ts';

const frames = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
const obliques = frames.filter((f: { camera: string }) => f.camera !== 'Color');

/** The middle of a frame's footprint, at its mean height: a point well inside the photo. */
function inside(f: { footprint3089: number[][] }): { x: number; y: number; z: number } {
  const c = f.footprint3089.slice(0, 4);
  return { x: c.reduce((s, p) => s + p[0]!, 0) / 4, y: c.reduce((s, p) => s + p[1]!, 0) / 4, z: meanGroundHeight(f.footprint3089) };
}

describe('the part of a photo a thumbnail shows', () => {
  it('has the thumbnail\'s own shape, at any size, so the picture is never stretched', () => {
    for (const f of obliques) {
      const camera = createCamera(f.eo, f.sensor);
      for (const [width, height] of [[120, 90], [180, 100], [96, 72], [200, 200]] as const) {
        const crop = cropFor({ camera, point: inside(f), width, height })!;
        assert.ok(crop, f.filename);
        assert.ok(Math.abs(crop.width / crop.height - width / height) < 1e-6, `${f.filename} ${width}x${height}: ${crop.width / crop.height}`);
      }
    }
  });

  it('shows more ground the wider the thumbnail is, at the same ground per pixel', () => {
    const f = obliques[0];
    const camera = createCamera(f.eo, f.sensor);
    const narrow = cropFor({ camera, point: inside(f), width: 120, height: 90 })!;
    const wide = cropFor({ camera, point: inside(f), width: 180, height: 100 })!;
    assert.ok(Math.abs(narrow.groundWidthFt - 250) < 1, `${narrow.groundWidthFt}`);
    assert.ok(Math.abs(wide.groundWidthFt - 375) < 1, `${wide.groundWidthFt}`);
    assert.ok(Math.abs(narrow.groundWidthFt / 120 - GROUND_FT_PER_THUMB_PX) < 0.01);
    assert.ok(Math.abs(wide.groundWidthFt / 180 - GROUND_FT_PER_THUMB_PX) < 0.01);
  });

  it('follows an explicit ground width when given one', () => {
    const f = obliques[0];
    const crop = cropFor({ camera: createCamera(f.eo, f.sensor), point: inside(f), width: 180, height: 100, groundWidthFt: 100 })!;
    assert.ok(Math.abs(crop.groundWidthFt - 100) < 1);
  });

  it('keeps the point in the crop, centred when the point is well inside the photo', () => {
    for (const f of obliques) {
      const crop = cropFor({ camera: createCamera(f.eo, f.sensor), point: inside(f), width: 180, height: 100 })!;
      assert.ok(Math.abs(crop.markerX - 0.5) < 0.02 && Math.abs(crop.markerY - 0.5) < 0.02, `${f.filename}: ${crop.markerX}, ${crop.markerY}`);
    }
  });
});
