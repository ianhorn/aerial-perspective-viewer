import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCamera } from '../src/camera.ts';
import {
  crossesItself, distance2d, distance3d, formatArea, formatDms, formatLength, formatPercent, formatRise, heightAbove, METRES_PER_FOOT, pathLength,
  perimeter, polygonArea, surfaceArea, surfacePoint, type Ground,
} from '../src/measure.ts';
import { meanGroundHeight } from '../src/scene.ts';

const frames = JSON.parse(readFileSync(new URL('./fixtures/frames.json', import.meta.url), 'utf8'));
const g = (x: number, y: number, z = 0): Ground => ({ x, y, z });
const close = (a: number, b: number, tol: number, what: string): void => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

/** The middle of a frame's footprint, and a sloping terrain through the footprint's mean height. */
function scene(f: { eo: { x: number; y: number; z: number }; footprint3089: number[][]; sensor: never }) {
  const cx = f.footprint3089.slice(0, 4).reduce((s, p) => s + p[0]!, 0) / 4;
  const cy = f.footprint3089.slice(0, 4).reduce((s, p) => s + p[1]!, 0) / 4;
  const z0 = meanGroundHeight(f.footprint3089);
  const heightAt = (x: number, y: number): number => z0 + 0.08 * (x - cx) - 0.05 * (y - cy);
  return { cx, cy, z0, heightAt };
}

describe('surfacePoint', () => {
  it('gives back the ground point a pixel was made from, on sloping ground, for every real camera', () => {
    for (const f of frames) {
      const camera = createCamera(f.eo, f.sensor);
      const { cx, cy, z0, heightAt } = scene(f);
      for (const [dx, dy] of [[0, 0], [300, -200], [-400, 350]] as const) {
        const x = cx + dx, y = cy + dy, z = heightAt(x, y);
        const pixel = camera.groundToPixel(x, y, z);
        if (!pixel) continue;
        const found = surfacePoint(camera, pixel[0], pixel[1], heightAt, z0);
        assert.ok(found, `${f.filename} ${dx},${dy}`);
        close(found.x, x, 0.01, `${f.filename} x`);
        close(found.y, y, 0.01, `${f.filename} y`);
        close(found.z, z, 0.01, `${f.filename} z`);
      }
    }
  });

  it('is null for a pixel that sees the sky', () => {
    const f = frames.find((x: { camera: string }) => x.camera === 'Fwd')!;
    const camera = createCamera(f.eo, f.sensor);
    assert.equal(surfacePoint(camera, camera.widthPx / 2, -40000, () => 500, 500), null); // well above the horizon, which is about 24,000 px above the centre
  });
});

describe('heightAbove', () => {
  it('recovers a known height above a ground point, for every real camera', () => {
    for (const f of frames) {
      const camera = createCamera(f.eo, f.sensor);
      const { cx, cy, heightAt } = scene(f);
      const base = g(cx + 120, cy - 80, heightAt(cx + 120, cy - 80));
      for (const h of [-15, 8, 45, 120, 300]) {
        const top = camera.groundToPixel(base.x, base.y, base.z + h);
        if (!top) continue;
        const found = heightAbove(camera, base, top[0], top[1]);
        assert.ok(found, `${f.filename} h=${h}`);
        close(found.height, h, 0.01, `${f.filename} h=${h}`);
        close(found.offPx, 0, 0.01, `${f.filename} offPx`);
      }
    }
  });

  it('answers with the nearest height when the click is off to the side, and says how far off it was', () => {
    const f = frames.find((x: { camera: string }) => x.camera === 'Bwd')!;
    const camera = createCamera(f.eo, f.sensor);
    const { cx, cy, heightAt } = scene(f);
    const base = g(cx, cy, heightAt(cx, cy));
    const top = camera.groundToPixel(base.x, base.y, base.z + 60)!;
    const onLine = heightAbove(camera, base, top[0], top[1])!;
    const aside = heightAbove(camera, base, top[0] + 30, top[1])!; // 30 px sideways
    assert.ok(aside.offPx > 10, `off by ${aside.offPx}`);
    close(aside.height, onLine.height, 15, 'the height barely changes when the click slides sideways');
  });

  it('is null when the base is straight under a camera looking down (the vertical line has no length in the picture)', () => {
    const f = frames.find((x: { camera: string }) => x.camera === 'Color')!;
    const camera = createCamera({ ...f.eo, omega: 0, phi: 0, kappa: 0 }, f.sensor);
    assert.equal(heightAbove(camera, g(f.eo.x, f.eo.y, 500), camera.widthPx / 2, camera.heightPx / 2), null);
  });
});

describe('lengths and areas', () => {
  it('measures distances level and along the slope', () => {
    assert.equal(distance2d(g(0, 0, 0), g(3, 4, 12)), 5);
    assert.equal(distance3d(g(0, 0, 0), g(3, 4, 12)), 13);
    assert.equal(pathLength([g(0, 0), g(3, 4), g(3, 14)], '2d'), 15);
    assert.equal(pathLength([g(0, 0, 0), g(3, 4, 12), g(3, 4, 12)], '3d'), 13);
    assert.equal(pathLength([g(1, 1)], '2d'), 0);
  });

  it('measures the area of a polygon, whichever way round it is drawn', () => {
    const square = [g(0, 0), g(100, 0), g(100, 100), g(0, 100)];
    assert.equal(polygonArea(square), 10000);
    assert.equal(polygonArea([...square].reverse()), 10000);
    assert.equal(polygonArea([g(0, 0), g(4, 0), g(0, 3)]), 6);
    assert.equal(polygonArea([g(1000, 1000), g(1100, 1000), g(1100, 1100), g(1000, 1100)]), 10000, 'far from the origin');
    assert.equal(perimeter(square), 400);
    assert.equal(polygonArea([g(0, 0), g(5, 5)]), 0);
  });

  it('finds an outline that crosses itself', () => {
    assert.equal(crossesItself([g(0, 0), g(10, 10), g(10, 0), g(0, 10)]), true, 'a bow tie');
    assert.equal(crossesItself([g(0, 0), g(10, 0), g(10, 10), g(0, 10)]), false);
    assert.equal(crossesItself([g(0, 0), g(10, 0), g(10, 5), g(5, 5), g(5, 10), g(0, 10)]), false, 'an L');
    assert.equal(crossesItself([g(0, 0), g(10, 0), g(5, 5)]), false, 'too few sides to cross');
  });
});

describe('surfaceArea', () => {
  const square = [g(5000, 8000), g(5100, 8000), g(5100, 8100), g(5000, 8100)];

  it('is the flat area on flat ground', () => {
    close(surfaceArea(square, () => 500), 10000, 1e-6, 'flat');
  });

  it('is the flat area over cos(slope) on a tilted plane, however the plane is tilted and the polygon is turned', () => {
    for (const [gx, gy] of [[0.3, 0], [0, -0.5], [0.2, 0.4]] as const) {
      const plane = (x: number, y: number): number => 400 + gx * (x - 5000) + gy * (y - 8000);
      const expected = 10000 * Math.sqrt(1 + gx * gx + gy * gy);
      close(surfaceArea(square, plane), expected, expected * 1e-4, `slope ${gx},${gy}`);
      const r = 50 * Math.SQRT2, diamond = [g(5050, 8050 - r), g(5050 + r, 8050), g(5050, 8050 + r), g(5050 - r, 8050)]; // the same area, turned 45 degrees
      close(surfaceArea(diamond, plane), expected, expected * 1e-3, `diamond ${gx},${gy}`);
    }
  });

  it('handles a concave outline, a tiny one and a degenerate one', () => {
    const plane = (x: number): number => 0.5 * x;
    const ell = [g(0, 0), g(100, 0), g(100, 50), g(50, 50), g(50, 100), g(0, 100)]; // 7,500 ft²
    close(surfaceArea(ell, plane), 7500 * Math.sqrt(1.25), 7500 * 1e-3, 'an L');
    close(surfaceArea([g(10, 10), g(10.5, 10), g(10, 10.5)], plane), 0.125 * Math.sqrt(1.25), 1e-3, 'smaller than the sample spacing');
    assert.equal(surfaceArea([g(0, 0), g(10, 10)], plane), 0);
  });

  it('is more than the flat area on a bump', () => {
    const bump = (x: number, y: number): number => 30 * Math.exp(-((x - 5050) ** 2 + (y - 8050) ** 2) / 800);
    assert.ok(surfaceArea(square, bump) > 10000 * 1.01);
  });
});

describe('degrees, minutes and seconds', () => {
  it('writes a latitude and longitude, with the hemisphere in place of a sign', () => {
    assert.equal(formatDms(37.40141, -85.995378), '37° 24′ 05.08″ N, 85° 59′ 43.36″ W');
    assert.equal(formatDms(-33.8688, 151.2093), '33° 52′ 07.68″ S, 151° 12′ 33.48″ E');
    assert.equal(formatDms(0, 0), '0° 00′ 00.00″ N, 0° 00′ 00.00″ E');
  });

  it('carries a rounded-up 60 seconds into the minute, and 60 minutes into the degree', () => {
    assert.equal(formatDms(10 + 59.996 / 3600, 0), '10° 01′ 00.00″ N, 0° 00′ 00.00″ E');
    assert.equal(formatDms(38.99999999, -86.99999999), '39° 00′ 00.00″ N, 87° 00′ 00.00″ W');
  });

  it('agrees with the decimal degrees it was made from, to 0.01 second', () => {
    for (const [lat, lon] of [[36.9, -89.1], [38.2288, -85.7878], [39.05, -82.0]] as const) {
      const [a, b] = formatDms(lat, lon).split(', ');
      const back = (text: string): number => { const m = /^(\d+)° (\d+)′ ([\d.]+)″/.exec(text)!; return +m[1]! + +m[2]! / 60 + +m[3]! / 3600; };
      assert.ok(Math.abs(back(a!) - lat) < 0.01 / 3600 + 1e-9);
      assert.ok(Math.abs(back(b!) - Math.abs(lon)) < 0.01 / 3600 + 1e-9);
    }
  });
});

describe('words for the numbers', () => {
  it('writes lengths in feet and metres, and miles when long', () => {
    assert.equal(formatLength(12.34), '12.3 ft (3.8 m)');
    assert.equal(formatLength(1234.5), '1,235 ft (376 m)');
    assert.equal(formatLength(10560), '10,560 ft (3,219 m · 2.00 mi)');
    close(METRES_PER_FOOT, 0.3048006096, 1e-9, 'the survey foot');
  });

  it('writes areas with acres and square metres', () => {
    assert.equal(formatArea(500), '500.0 ft² (0.011 acres · 46.5 m²)');
    assert.equal(formatArea(43560), '43,560 ft² (1.000 acres · 4,047 m²)');
    assert.equal(formatArea(4356000), '4,356,000 ft² (100.0 acres · 404,687 m²)');
  });

  it('writes a change with its sign, and a slope as a percentage', () => {
    assert.equal(formatRise(12.34), '+12.3 ft (+3.8 m)');
    assert.equal(formatRise(-5), '−5.0 ft (−1.5 m)');
    assert.equal(formatRise(0), '0.0 ft (0.0 m)');
    assert.equal(formatPercent(0.1234), '12.3%');
  });
});
