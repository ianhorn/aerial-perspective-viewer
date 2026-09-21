import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundsOf, CIRCLE_SEGMENTS, circleRing, geometryOf, groundDistanceM, labelPoint, measuresOf, rectangleWithCorner, ringOf, screenRectangle, type LonLat } from '../src/draw-geometry.ts';
import type { DrawFeature } from '../src/draw-model.ts';
import { gridToLonLat, lonLatToGrid } from '../src/lcc.ts';

const make = (kind: DrawFeature['kind'], coordinates: LonLat[], extra: Partial<DrawFeature> = {}): DrawFeature => ({
  id: 'x', kind, coordinates, properties: { label: '', notes: '', color: '#e53935' }, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
/** The distance between two places in metres on the GRS80 ellipsoid (Vincenty's inverse formula), an independent check on the State Plane work. */
function distance(a: LonLat, b: LonLat): number {
  const A = 6378137, f = 1 / 298.257222101, B = A * (1 - f), rad = Math.PI / 180;
  const U1 = Math.atan((1 - f) * Math.tan(a[1] * rad)), U2 = Math.atan((1 - f) * Math.tan(b[1] * rad));
  const L = (b[0] - a[0]) * rad;
  let lambda = L, sinSigma = 0, cosSigma = 0, sigma = 0, cosSqAlpha = 0, cos2SigmaM = 0;
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  for (let i = 0; i < 100; i++) {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - previous) < 1e-12) break;
  }
  const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
  const AA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const BBc = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const dSigma = BBc * sinSigma * (cos2SigmaM + (BBc / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - (BBc / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return B * AA * (sigma - dSigma);
}
const LOUISVILLE: LonLat = [-85.7585, 38.2527], PIKEVILLE: LonLat = [-82.5188, 37.4793], PADUCAH: LonLat = [-88.6, 37.08];

describe('circles', () => {
  it('are closed rings of 64 points, every one the radius from the centre by an independent ellipsoidal distance', () => {
    for (const centre of [LOUISVILLE, PIKEVILLE, PADUCAH]) {
      for (const radiusM of [5, 250, 5000, 40_000]) {
        const ring = circleRing(centre, radiusM);
        assert.equal(ring.length, CIRCLE_SEGMENTS + 1);
        assert.deepEqual(ring[0], ring.at(-1));
        for (const p of ring) {
          const d = distance(centre, p);
          // the projection's own scale error (State Plane is good to about 0.03% across the state) plus a couple of centimetres
          assert.ok(Math.abs(d - radiusM) <= radiusM * 0.0005 + 0.02, `${radiusM} m at ${centre}: ${d}`);
        }
      }
    }
  });

  it('measure exactly pi r squared, not the area of the ring that draws them', () => {
    const f = make('circle', [LOUISVILLE], { radiusM: 100 });
    const m = measuresOf(f);
    const rFt = 100 * 3937 / 1200;
    assert.ok(Math.abs(m.areaSqFt! - Math.PI * rFt * rFt) < 1e-6);
    assert.ok(Math.abs(m.perimeterFt! - 2 * Math.PI * rFt) < 1e-6);
    assert.ok(Math.abs(m.radiusFt! - rFt) < 1e-9);
  });

  it('are exported as a polygon of one ring, and have the ring\'s bounds', () => {
    const f = make('circle', [LOUISVILLE], { radiusM: 500 });
    const g = geometryOf(f);
    assert.equal(g.type, 'Polygon');
    assert.equal(g.type === 'Polygon' && g.coordinates.length, 1);
    const [w, s, e, n] = boundsOf(f);
    assert.ok(w < LOUISVILLE[0] && e > LOUISVILLE[0] && s < LOUISVILLE[1] && n > LOUISVILLE[1]);
    assert.ok(Math.abs(distance([w, LOUISVILLE[1]], [e, LOUISVILLE[1]]) - 1000) < 1); // a kilometre across
  });
});

describe('rectangles and polygons', () => {
  const square = (side: number): LonLat[] => {
    const [x, y] = lonLatToGrid(LOUISVILLE[0], LOUISVILLE[1]);
    return [[x, y], [x + side, y], [x + side, y + side], [x, y + side]].map(([gx, gy]) => gridToLonLat(gx!, gy!));
  };

  it('measure their sides and area in feet, and the sides agree with an independent ellipsoidal distance', () => {
    const f = make('rectangle', square(1000));
    const m = measuresOf(f);
    assert.ok(Math.abs(m.areaSqFt! - 1_000_000) < 0.5);
    assert.ok(Math.abs(m.perimeterFt! - 4000) < 0.05);
    const side = distance(f.coordinates[0]!, f.coordinates[1]!);
    assert.ok(Math.abs(side - 1000 * 1200 / 3937) < 0.16, `${side} m`); // 304.8 m, to 0.05%
  });

  it('close themselves in the exported ring, without changing what was stored', () => {
    const f = make('polygon', square(500).slice(0, 3));
    const ring = ringOf(f);
    assert.equal(ring.length, 4);
    assert.deepEqual(ring[0], ring[3]);
    assert.equal(f.coordinates.length, 3);
  });

  it('measure the length of a line', () => {
    const [x, y] = lonLatToGrid(LOUISVILLE[0], LOUISVILLE[1]);
    const f = make('line', [[x, y], [x + 300, y], [x + 300, y + 400]].map(([gx, gy]) => gridToLonLat(gx!, gy!)));
    assert.ok(Math.abs(measuresOf(f).lengthFt! - 700) < 0.05);
    assert.deepEqual(measuresOf(make('point', [LOUISVILLE])), {});
  });

  it('are made from two opposite screen corners, in order round', () => {
    assert.deepEqual(screenRectangle({ x: 10, y: 20 }, { x: 110, y: 90 }), [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 90 }, { x: 10, y: 90 }]);
  });
});

describe('labels', () => {
  it('go on a point or a circle\'s centre', () => {
    assert.deepEqual(labelPoint(make('point', [LOUISVILLE])), LOUISVILLE);
    assert.deepEqual(labelPoint(make('circle', [LOUISVILLE], { radiusM: 10 })), LOUISVILLE);
    assert.deepEqual(labelPoint(make('text', [LOUISVILLE])), LOUISVILLE);
  });

  it('go halfway along a line, by its length, not its vertices', () => {
    const [x, y] = lonLatToGrid(LOUISVILLE[0], LOUISVILLE[1]);
    // 100 ft east then 900 ft north: 1,000 ft in all, so the middle is 500 ft along, which is 400 ft up the second leg
    const f = make('line', [[x, y], [x + 100, y], [x + 100, y + 900]].map(([gx, gy]) => gridToLonLat(gx!, gy!)));
    const [lx, ly] = lonLatToGrid(...labelPoint(f));
    assert.ok(Math.abs(lx - (x + 100)) < 0.05 && Math.abs(ly - (y + 400)) < 0.05, `${lx - x}, ${ly - y}`);
  });

  it('go at the centre of a polygon, and inside it when the centre falls outside (an L)', () => {
    const [x, y] = lonLatToGrid(LOUISVILLE[0], LOUISVILLE[1]);
    const g = (pts: number[][]) => pts.map(([gx, gy]) => gridToLonLat(x + gx!, y + gy!));
    const box = make('polygon', g([[0, 0], [200, 0], [200, 100], [0, 100]]));
    const [bx, by] = lonLatToGrid(...labelPoint(box));
    assert.ok(Math.abs(bx - (x + 100)) < 0.05 && Math.abs(by - (y + 50)) < 0.05);
    // an L with arms 20 ft wide: its centre of mass lies in the notch, outside the shape. The label goes in an arm, well inside it.
    const ell = make('polygon', g([[0, 0], [300, 0], [300, 20], [20, 20], [20, 300], [0, 300]]));
    const [ex, ey] = lonLatToGrid(...labelPoint(ell));
    const rx = ex - x, ry = ey - y;
    const inArm = (rx > 0 && rx < 300 && ry > 0 && ry < 20) || (rx > 0 && rx < 20 && ry > 0 && ry < 300);
    assert.ok(inArm, `label at ${rx}, ${ry}`);
    assert.ok(Math.min(ry, 20 - ry) > 8 || Math.min(rx, 20 - rx) > 8, `label at ${rx}, ${ry} is too near an edge`); // the middle of an arm: 10 ft in
  });
});

describe('dragging a rectangle corner', () => {
  const near = (a: { x: number; y: number }, x: number, y: number) => assert.ok(Math.hypot(a.x - x, a.y - y) < 1e-9, `(${a.x}, ${a.y}) is not (${x}, ${y})`);

  it('moves the corner and its two neighbours, and keeps the opposite corner', () => {
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const r = rectangleWithCorner(square, 2, { x: 160, y: 90 });
    near(r[0]!, 0, 0); near(r[1]!, 160, 0); near(r[2]!, 160, 90); near(r[3]!, 0, 90);
  });

  it('works for every corner', () => {
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const r0 = rectangleWithCorner(square, 0, { x: -20, y: -30 });
    near(r0[0]!, -20, -30); near(r0[1]!, 100, -30); near(r0[2]!, 100, 50); near(r0[3]!, -20, 50);
    const r1 = rectangleWithCorner(square, 1, { x: 130, y: -10 });
    near(r1[0]!, 0, -10); near(r1[1]!, 130, -10); near(r1[2]!, 130, 50); near(r1[3]!, 0, 50);
    const r3 = rectangleWithCorner(square, 3, { x: 10, y: 80 });
    near(r3[0]!, 10, 0); near(r3[1]!, 100, 0); near(r3[2]!, 100, 80); near(r3[3]!, 10, 80);
  });

  it('keeps a turned rectangle turned, and the sides at right angles', () => {
    // a 100 x 50 rectangle turned by 30 degrees about the origin
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const turn = (x: number, y: number) => ({ x: x * c - y * s, y: x * s + y * c });
    const rect = [turn(0, 0), turn(100, 0), turn(100, 50), turn(0, 50)];
    const target = turn(140, 90); // where the far corner should end up
    const r = rectangleWithCorner(rect, 2, { x: target.x + 0.0, y: target.y });
    near(r[2]!, target.x, target.y);
    near(r[0]!, rect[0]!.x, rect[0]!.y);
    const side1 = { x: r[1]!.x - r[0]!.x, y: r[1]!.y - r[0]!.y }, side2 = { x: r[3]!.x - r[0]!.x, y: r[3]!.y - r[0]!.y };
    assert.ok(Math.abs(side1.x * side2.x + side1.y * side2.y) < 1e-9); // right angle
    assert.ok(Math.abs(Math.hypot(side1.x, side1.y) - 140) < 1e-9);
    assert.ok(Math.abs(Math.hypot(side2.x, side2.y) - 90) < 1e-9);
  });

  it('is left as it is when it has no size', () => {
    const flat = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    assert.deepEqual(rectangleWithCorner(flat, 2, { x: 10, y: 10 }), flat);
  });
});

describe('the distance between two places', () => {
  it('agrees with an ellipsoidal calculation', () => {
    const a: [number, number] = [-85.75, 38.25], b: [number, number] = [-85.2, 38.6];
    const expected = distance(a, b);
    const got = groundDistanceM(a, b);
    assert.ok(Math.abs(got - expected) <= expected * 0.0005 + 0.02, `${got} vs ${expected}`);
  });
  it('is zero for the same place', () => assert.equal(groundDistanceM([-85, 38], [-85, 38]), 0));
});
