import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';

interface Fixture {
  filename: string;
  camera: string;
  eo: { x: number; y: number; z: number; omega: number; phi: number; kappa: number };
  sensor: { widthPx: number; heightPx: number; focalMm: number; ccdResUm: number; ppxMm: number; ppyMm: number };
  footprint3089: [number, number, number][];
}

// Real frames from the database: every camera on both sensors, with the vendor's footprints.
const frames: Fixture[] = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
const cameraOf = (f: Fixture) => createCamera(f.eo, f.sensor);
const TOLERANCE_PX = 0.05; // the vendor's footprints agree with the model to about 0.005 px, so this is generous

describe('camera model', () => {
  it('has fixtures for all five cameras on both sensors', () => {
    assert.equal(frames.length, 10);
    assert.deepEqual([...new Set(frames.map((f) => f.camera))].sort(), ['Bwd', 'Color', 'Fwd', 'Left', 'Right']);
    assert.deepEqual([...new Set(frames.map((f) => f.sensor.ccdResUm))].sort(), [3.76, 5.2]);
  });

  it('puts the vendor footprint of an oblique on its image corners: top-left, top-right, bottom-right, bottom-left', () => {
    for (const f of frames.filter((x) => x.camera !== 'Color')) {
      const camera = cameraOf(f);
      const { widthPx: w, heightPx: h } = camera;
      const corners = [[0, 0], [w, 0], [w, h], [0, h]];
      corners.forEach(([col, row], i) => {
        const [x, y, z] = f.footprint3089[i]!;
        const pixel = camera.groundToPixel(x, y, z)!;
        assert.ok(Math.hypot(pixel[0] - col!, pixel[1] - row!) < TOLERANCE_PX, `${f.filename} vertex ${i}: got ${pixel}, want ${col},${row}`);
      });
    }
  });

  it('puts the four vertices of a Color footprint on the four image corners, in whatever order', () => {
    for (const f of frames.filter((x) => x.camera === 'Color')) {
      const camera = cameraOf(f);
      const { widthPx: w, heightPx: h } = camera;
      const wanted = new Set(['0,0', `${w},0`, `${w},${h}`, `0,${h}`]);
      for (const [x, y, z] of f.footprint3089.slice(0, 4)) {
        const [col, row] = camera.groundToPixel(x!, y!, z!)!;
        const key = `${Math.round(col)},${Math.round(row)}`;
        assert.ok(wanted.delete(key), `${f.filename}: ${key} is not a free corner`);
        assert.ok(Math.abs(col - Math.round(col)) < TOLERANCE_PX && Math.abs(row - Math.round(row)) < TOLERANCE_PX);
      }
      assert.equal(wanted.size, 0);
    }
  });

  it('turns a pixel into the ground and back again', () => {
    for (const f of frames) {
      const camera = cameraOf(f);
      for (const [u, v] of [[0.5, 0.5], [0.1, 0.9], [0.95, 0.2], [0.3, 0.7]]) {
        const col = u! * camera.widthPx;
        const row = v! * camera.heightPx;
        const ground = camera.pixelToGround(col, row, 600)!;
        const back = camera.groundToPixel(ground[0], ground[1], 600)!;
        assert.ok(Math.hypot(back[0] - col, back[1] - row) < 1e-6, f.filename);
      }
    }
  });

  it('sees the ground near the middle of its footprint at the centre of the photo', () => {
    for (const f of frames) {
      const [x, y] = cameraOf(f).pixelToGround(f.sensor.widthPx / 2, f.sensor.heightPx / 2, f.footprint3089[0]![2])!;
      const xs = f.footprint3089.map((p) => p[0]);
      const ys = f.footprint3089.map((p) => p[1]);
      assert.ok(x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys), f.filename);
    }
  });

  it('says null for a point behind the camera and for a ray that never reaches the plane', () => {
    const f = frames[0]!;
    const camera = cameraOf(f);
    // Directly above the camera is behind an oblique that looks down.
    assert.equal(camera.groundToPixel(f.eo.x, f.eo.y, f.eo.z + 5000), null);
    // A plane above the camera can't be reached by rays that go downward.
    assert.equal(camera.pixelToGround(f.sensor.widthPx / 2, f.sensor.heightPx / 2, f.eo.z + 1000), null);
  });

  it('refuses lens mounting angles it does not apply', () => {
    const f = frames[0]!;
    assert.throws(() => createCamera(f.eo, { ...f.sensor, kappaDg: 0.5 }), /mounting angles/);
    assert.doesNotThrow(() => createCamera(f.eo, { ...f.sensor, omegaDg: 0, phiDg: 0, kappaDg: 0 }));
  });
});
