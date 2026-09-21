import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gridToLonLat } from '../src/lcc.ts';
import { areaSqMi, gridBox, insideGrid, MAX_AOI_SQ_MI, toGeoJsonPolygon, withinLimit, type LonLat } from '../src/pc-aoi.ts';
import { boxTouchesPolygon, boxesOverlap, coveredShare, DEFAULT_BUDGET, nodeBox, selectNodes, type Box, type NodeRef } from '../src/pc-plan.ts';
import { heightRange, RAMP, rampColor } from '../src/pc-ramp.ts';
import { lonLatToMercator, metreInMercator, Warp } from '../src/pc-warp.ts';

/** A polygon of places that is a rectangle on the grid, corners in order. */
const gridBoxRing = (x0: number, y0: number, w: number, h: number): LonLat[] => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]].map(([x, y]) => gridToLonLat(x!, y!));

describe('the ramp', () => {
  it('has viridis at its stops and halfway between them, worked out by hand', () => {
    assert.deepEqual(rampColor(0), [68, 1, 84]);
    assert.deepEqual(rampColor(0.5), [33, 145, 140]);
    assert.deepEqual(rampColor(1), [253, 231, 37]);
    assert.deepEqual(rampColor(0.125), [63.5, 41.5, 111.5]); // half way from the first stop to the second
    assert.deepEqual(rampColor(0.875), [(94 + 253) / 2, (201 + 231) / 2, (98 + 37) / 2]);
  });
  it('holds at the ends and copes with nonsense', () => {
    assert.deepEqual(rampColor(-3), [...RAMP[0]!]);
    assert.deepEqual(rampColor(7), [...RAMP[4]!]);
    assert.deepEqual(rampColor(NaN), [...RAMP[0]!]);
  });
  it('a height range is the 2nd to 98th percentile, so strays do not squash the rest', () => {
    const heights = Array.from({ length: 1001 }, (_, i) => 400 + i / 10); // 400 to 500
    heights.push(5000, -300); // a bird and a low outlier
    const [lo, hi] = heightRange(heights)!;
    assert.ok(lo > 400 && lo < 405, `${lo}`);
    assert.ok(hi < 500 && hi > 495, `${hi}`);
    assert.equal(heightRange([]), null);
    assert.deepEqual(heightRange([7, 7, 7]), [7, 8]); // never an empty range
  });
});

describe('the area', () => {
  it('a square mile on the grid is a square mile', () => {
    assert.ok(Math.abs(areaSqMi(gridBoxRing(4_900_000, 3_900_000, 5280, 5280)) - 1) < 1e-6);
    assert.ok(Math.abs(areaSqMi(gridBoxRing(4_900_000, 3_900_000, 10560, 2640)) - 1) < 1e-6);
  });

  it('is left alone under the limit, and shrunk to exactly the limit about its middle above it', () => {
    const small = gridBoxRing(4_900_000, 3_900_000, 5280, 5280);
    const same = withinLimit(small);
    assert.equal(same.limited, false);
    assert.deepEqual(same.ring, small);

    const big = gridBoxRing(4_900_000, 3_900_000, 26400, 15840); // 5 x 3 = 15 square miles
    const shrunk = withinLimit(big);
    assert.equal(shrunk.limited, true);
    assert.ok(Math.abs(areaSqMi(shrunk.ring) - MAX_AOI_SQ_MI) < 1e-6);
    const [x0, y0, x1, y1] = gridBox(shrunk.ring);
    assert.ok(Math.abs((x0 + x1) / 2 - (4_900_000 + 13200)) < 1e-3 && Math.abs((y0 + y1) / 2 - (3_900_000 + 7920)) < 1e-3); // the same middle
    assert.ok(Math.abs((x1 - x0) / (y1 - y0) - 26400 / 15840) < 1e-9); // the same shape
  });

  it('a limit of your own is used', () => {
    assert.ok(Math.abs(areaSqMi(withinLimit(gridBoxRing(4_900_000, 3_900_000, 5280, 5280), 0.25).ring) - 0.25) < 1e-6);
  });

  it('closes the ring for a STAC search, longitude first, without changing the input', () => {
    const ring: LonLat[] = [[-85.8, 38.2], [-85.7, 38.2], [-85.7, 38.3]];
    const poly = toGeoJsonPolygon(ring);
    assert.equal(poly.coordinates[0]!.length, 4);
    assert.deepEqual(poly.coordinates[0]![0], poly.coordinates[0]![3]);
    assert.equal(ring.length, 3);
  });

  it('knows what is inside a polygon of the grid', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(insideGrid(sq, 5, 5), true);
    assert.equal(insideGrid(sq, 11, 5), false);
    assert.equal(insideGrid(sq, 5, -1), false);
    const l: [number, number][] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    assert.equal(insideGrid(l, 2, 8), true);
    assert.equal(insideGrid(l, 8, 8), false);
  });
});

describe('the fast projection', () => {
  it('Web Mercator agrees with PROJ (EPSG:4326 to 3857, pyproj 3.8)', () => {
    for (const [lon, lat, x, y] of [[-85.75, 38.25, 0.26180555555555557, 0.3848458901126288], [-89.5, 36.6, 0.2513888888888889, 0.3906176964232623], [-82.0, 39.1, 0.2722222222222222, 0.3818214876621149]] as const) {
      const [mx, my] = lonLatToMercator(lon, lat);
      assert.ok(Math.abs(mx - x) < 1e-12 && Math.abs(my - y) < 1e-12, `${lon} ${lat}: ${mx} ${my}`);
    }
  });

  it('a metre in Web Mercator units is the map\'s scale at that latitude', () => {
    // at the equator the world is 40,075,016.686 m round; at 60 degrees a metre is twice as many units
    assert.ok(Math.abs(metreInMercator(0) - 1 / 40075016.686) < 1e-20);
    assert.ok(Math.abs(metreInMercator(60) / metreInMercator(0) - 2) < 1e-9);
  });

  it('places any point within a millimetre of the exact conversion, over four miles of the state, in either corner of it', () => {
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (const [x0, y0] of [[4_915_000, 3_975_000], [3_990_000, 3_560_000], [5_800_000, 4_200_000]] as const) {
      const box: Box = [x0, y0, x0 + 21120, y0 + 21120]; // four miles across
      const warp = new Warp(box);
      const out = new Float64Array(2);
      let worst = 0;
      for (let k = 0; k < 400; k++) {
        const x = box[0] + rnd() * 21120, y = box[1] + rnd() * 21120;
        const [lon, lat] = gridToLonLat(x, y);
        const [ex, ey] = lonLatToMercator(lon, lat);
        warp.place(x, y, out);
        worst = Math.max(worst, Math.hypot(out[0]! - ex, out[1]! - ey) / metreInMercator(lat));
      }
      assert.ok(worst < 0.001, `worst ${worst} m at ${x0}, ${y0}`);
    }
  });

  it('a lattice is no bigger than it needs to be, and is still right at the very edge of the box', () => {
    const box: Box = [4_915_000, 3_975_000, 4_916_000, 3_976_000];
    const warp = new Warp(box);
    assert.ok(warp.cols * warp.rows < 100);
    const out = new Float64Array(2);
    for (const [x, y] of [[box[0], box[1]], [box[2], box[3]], [box[0], box[3]]] as const) {
      warp.place(x, y, out);
      const [lon, lat] = gridToLonLat(x, y);
      const [ex, ey] = lonLatToMercator(lon, lat);
      assert.ok(Math.hypot(out[0]! - ex, out[1]! - ey) / metreInMercator(lat) < 0.001);
    }
  });
});

describe('planning what to read', () => {
  const cube = [4_914_999.99, 3_974_999.99, 380, 4_919_999.99, 3_979_999.99, 5380];

  it('a node\'s footprint is one 2^depth-th of the cube', () => {
    assert.deepEqual(nodeBox(cube, '0-0-0-0'), [4_914_999.99, 3_974_999.99, 4_919_999.99, 3_979_999.99]);
    const b = nodeBox(cube, '2-1-3-0'); // 1,250 ft across
    assert.ok(Math.abs(b[0] - (4_914_999.99 + 1250)) < 1e-6 && Math.abs(b[1] - (3_974_999.99 + 3750)) < 1e-6 && Math.abs(b[2] - b[0] - 1250) < 1e-6);
  });

  it('boxes and polygons: overlap, containment, crossing, and near misses', () => {
    const box: Box = [0, 0, 10, 10];
    assert.equal(boxesOverlap(box, [5, 5, 15, 15]), true);
    assert.equal(boxesOverlap(box, [10, 0, 20, 10]), false); // sharing only an edge
    assert.equal(boxTouchesPolygon(box, [[2, 2], [4, 2], [3, 4]]), true); // inside the box
    assert.equal(boxTouchesPolygon(box, [[-5, -5], [20, -5], [20, 20], [-5, 20]]), true); // the box inside the polygon
    assert.equal(boxTouchesPolygon(box, [[-5, 4], [15, 4], [15, 6], [-5, 6]]), true); // a band across it, no corner of either inside the other
    assert.equal(boxTouchesPolygon(box, [[11, 0], [20, 0], [20, 10]]), false);
    assert.equal(boxTouchesPolygon(box, [[-10, 12], [12, 30], [-10, 30]]), false); // a triangle beyond a corner
  });

  it('the share of a node the area covers', () => {
    assert.equal(coveredShare([0, 0, 100, 100], [0, 0, 100, 100]), 1);
    assert.equal(coveredShare([0, 0, 100, 100], [50, 0, 200, 100]), 0.5);
    assert.equal(coveredShare([0, 0, 100, 100], [200, 200, 300, 300]), 0);
    assert.equal(coveredShare([0, 0, 100, 100], [25, 25, 75, 75]), 0.25);
  });

  const node = (depth: number, count: number, length: number, file = 0, key = `${depth}-0-0-0`): NodeRef => ({ file, key, depth, count, offset: 0, length, box: [0, 0, 1000, 1000], spacingFt: 100 / 2 ** depth });
  const aoi: Box = [0, 0, 1000, 1000];

  it('takes every level while the budget holds, and stops before the level that breaks it', () => {
    const nodes = [node(0, 1000, 5000), node(1, 3000, 15000, 0, '1-0-0-0'), node(2, 10000, 50000, 0, '2-0-0-0'), node(3, 90000, 450000, 0, '3-0-0-0')];
    let s = selectNodes(nodes, aoi, { maxPoints: 20000, maxBytes: 1e9 });
    assert.equal(s.depth, 2);
    assert.equal(s.points, 14000);
    assert.equal(s.bytes, 70000);
    assert.equal(s.nodes.length, 3);
    assert.equal(s.deepest, 3);
    assert.equal(s.over, false);
    s = selectNodes(nodes, aoi, { maxPoints: 1e9, maxBytes: 60000 }); // bytes are limited too
    assert.equal(s.depth, 1);
    s = selectNodes(nodes, aoi, { maxPoints: 1e9, maxBytes: 1e9 });
    assert.equal(s.depth, 3);
  });

  it('counts only the share of a node that the area covers, but every byte of it', () => {
    const half = { ...node(1, 1000, 8000), box: [0, 0, 2000, 1000] as Box }; // the area covers half of it
    const s = selectNodes([node(0, 100, 500), half], aoi, { maxPoints: 1e9, maxBytes: 1e9 });
    assert.equal(s.points, 100 + 500);
    assert.equal(s.bytes, 500 + 8000);
  });

  it('reads the top level even when that alone is over the budget, and says so', () => {
    const s = selectNodes([node(0, 5_000_000, 1e6), node(1, 100, 1)], aoi, DEFAULT_BUDGET);
    assert.equal(s.depth, 0);
    assert.equal(s.over, true);
    assert.equal(s.nodes.length, 1);
  });

  it('works across several files, a level at a time', () => {
    const nodes = [node(0, 500, 1000, 0), node(0, 500, 1000, 1), node(1, 4000, 8000, 0, '1-0-0-0'), node(1, 4000, 8000, 1, '1-0-0-0')];
    const s = selectNodes(nodes, aoi, { maxPoints: 5000, maxBytes: 1e9 });
    assert.equal(s.depth, 0); // 1,000 fits, 9,000 does not
    assert.equal(s.nodes.length, 2);
  });

  it('is empty-safe', () => {
    const s = selectNodes([], aoi);
    assert.deepEqual([s.depth, s.nodes.length, s.points, s.bytes, s.over], [0, 0, 0, 0, false]);
  });
});
