import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gridToLonLat, lonLatToGrid } from '../src/lcc.ts';

// Grid feet -> lon/lat as PostGIS computes it for SRID 3089 (ST_Transform to 4326).
const REFERENCE: [number, number, number, number][] = [
  [1500000.0, 1000000.0, -96.425408346, 29.554123343],
  [2100000.0, 3400000.0, -95.333101888, 36.262439771],
  [4930650.3407, 3968749.8975, -85.717276798, 38.222598260],
  [5900000.0, 4200000.0, -82.314813913, 38.808116956],
  [3100000.0, 3600000.0, -91.994531849, 37.042458100],
  [2500000.0, 2100000.0, -93.610639464, 32.814452807],
  [6100000.0, 3300000.0, -81.749015232, 36.316566984],
];

describe('EPSG:3089 projection', () => {
  it('agrees with PostGIS to about a centimetre', () => {
    for (const [x, y, lon, lat] of REFERENCE) {
      const [gotLon, gotLat] = gridToLonLat(x, y);
      // Most points agree to 1e-9 degrees (0.1 mm). The far-east one differs by 6 mm, in both directions, while each
      // implementation is self-consistent, so it is a difference between the two, not an error. The imagery is
      // accurate to about 0.67 ft, so 1e-7 degrees (1.1 cm) is plenty.
      assert.ok(Math.abs(gotLon - lon) < 1e-7 && Math.abs(gotLat - lat) < 1e-7, `${x},${y}: ${gotLon},${gotLat}`);
    }
  });

  it('goes there and back', () => {
    for (const [x, y] of REFERENCE) {
      const [lon, lat] = gridToLonLat(x, y);
      const [bx, by] = lonLatToGrid(lon, lat);
      assert.ok(Math.hypot(bx - x, by - y) < 1e-4, `${x},${y}`);
    }
  });

  it('puts the false origin on the central meridian', () => {
    assert.ok(Math.abs(gridToLonLat(4921250, 1000000 * 3937 / 1200)[0] + 85.75) < 1e-9);
  });
});
