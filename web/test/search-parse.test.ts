import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lonLatToGrid } from '../src/lcc.ts';
import { describeCoordinates, parseCoordinates } from '../src/search-parse.ts';

const LAT = 38.2288, LNG = -85.7878; // Louisville, used throughout
const at = (text: string, lng = LNG, lat = LAT, tol = 1e-4) => {
  const c = parseCoordinates(text);
  assert.ok(c, `"${text}" should be read as coordinates`);
  assert.ok(Math.abs(c.lat - lat) < tol && Math.abs(c.lng - lng) < tol, `"${text}" gave ${c.lat}, ${c.lng}`);
  return c;
};

describe('decimal degrees', () => {
  it('reads latitude then longitude, with a comma, a space, a semicolon or both', () => {
    for (const t of ['38.2288, -85.7878', '38.2288 -85.7878', '38.2288,-85.7878', '38.2288;-85.7878', '  38.2288 ,  -85.7878  ']) assert.equal(at(t).kind, 'decimal');
  });

  it('reads degree signs and hemisphere letters, before or after the numbers', () => {
    for (const t of ['38.2288° N, 85.7878° W', '38.2288 N 85.7878 W', 'N38.2288 W85.7878', 'N 38.2288, W 85.7878', '38.2288N 85.7878W', '38.2288°N,85.7878°W']) at(t);
  });

  it('lets the hemisphere letters put longitude first', () => {
    at('85.7878 W, 38.2288 N');
    at('W85.7878 N38.2288');
  });

  it('takes a longitude written first when the numbers can only be that way round', () => {
    at('-85.7878, 38.2288'); // not a latitude of -85.79 in Kentucky's neighbourhood
    at('-85.7878 38.2288');
  });

  it('accepts the words lat and lon, and whole numbers', () => {
    at('lat 38.2288 lon -85.7878');
    at('Latitude: 38.2288, Longitude: -85.7878');
    at('38, -85', -85, 38, 1e-9);
  });

  it('keeps a southern or eastern hemisphere', () => {
    const c = parseCoordinates('33.8688 S, 151.2093 E')!;
    assert.ok(Math.abs(c.lat + 33.8688) < 1e-9 && Math.abs(c.lng - 151.2093) < 1e-9);
  });
});

describe('degrees, minutes and seconds', () => {
  const dms = { lat: 38 + 13 / 60 + 44 / 3600, lng: -(85 + 47 / 60 + 16 / 3600) };
  it('reads the usual writings', () => {
    for (const t of ['38°13\'44"N 85°47\'16"W', '38° 13\' 44" N, 85° 47\' 16" W', '38 13 44 N, 85 47 16 W', '38d13m44s N 85d47m16s W', '38°13′44″N 85°47′16″W', 'N 38 13 44 W 85 47 16']) {
      const c = at(t, dms.lng, dms.lat, 1e-6);
      assert.equal(c.kind, 'dms');
    }
  });

  it('reads minutes and seconds without hemisphere letters, by count', () => {
    at('38 13 44 -85 47 16', dms.lng, dms.lat, 1e-6);
    at('38°13\'44" -85°47\'16"', dms.lng, dms.lat, 1e-6);
  });

  it('reads degrees and decimal minutes', () => {
    at('38°13.733\'N 85°47.267\'W', -(85 + 47.267 / 60), 38 + 13.733 / 60, 1e-6);
    at('38 13.733 N, 85 47.267 W', -(85 + 47.267 / 60), 38 + 13.733 / 60, 1e-6);
  });

  it('turns a negative first number into the whole angle, not just the degrees', () => {
    const c = parseCoordinates('38 13 44, -85 47 16')!;
    assert.ok(Math.abs(c.lng + (85 + 47 / 60 + 16 / 3600)) < 1e-9);
  });

  it('refuses minutes or seconds that are 60 or more, and a fraction in the middle', () => {
    assert.equal(parseCoordinates('38 75 00 N, 85 10 00 W'), null);
    assert.equal(parseCoordinates('38 13 61 N, 85 10 00 W'), null);
    assert.equal(parseCoordinates('38.5 13 44 N, 85 47 16 W'), null);
  });
});

describe('Kentucky State Plane feet (EPSG:3089)', () => {
  const [x, y] = lonLatToGrid(LNG, LAT);
  it('reads a pair of large numbers, with or without commas, labels and units', () => {
    const shown = (n: number) => Math.round(n).toLocaleString('en-US');
    for (const t of [
      `${Math.round(x)} ${Math.round(y)}`, `${Math.round(x)}, ${Math.round(y)}`, `${shown(x)} ${shown(y)}`, `${shown(x)}, ${shown(y)}`,
      `${Math.round(x)} E, ${Math.round(y)} N`, `x=${Math.round(x)} y=${Math.round(y)}`, `E ${Math.round(x)} N ${Math.round(y)}`, `${shown(x)} ft, ${shown(y)} ft`,
    ]) {
      const c = at(t, LNG, LAT, 1e-4);
      assert.equal(c.kind, 'stateplane');
    }
  });

  it('takes the northing first when it is labelled so', () => {
    at(`N ${Math.round(y)} E ${Math.round(x)}`);
    at(`y=${Math.round(y)} x=${Math.round(x)}`);
  });

  it('refuses a pair that is nowhere near Kentucky in either order', () => {
    assert.equal(parseCoordinates('123456 234567'), null);
    assert.equal(parseCoordinates('9000000 9000000'), null);
  });
});

describe('what is not a coordinate pair', () => {
  it('leaves addresses, places and ZIP codes to the search', () => {
    for (const t of ['100 W Main St', '401 W Main St, Louisville, KY', 'Louisville', 'Bowling Green, KY', 'Cherokee Park', '40202', '40202 40203', '4th St & Main St', 'Warren County', '2 miles north of 42101', '', '   ']) {
      assert.equal(parseCoordinates(t), null, `"${t}"`);
    }
  });

  it('refuses out-of-range numbers and two latitudes', () => {
    assert.equal(parseCoordinates('95.5 100.2'), null); // neither can be a latitude
    assert.deepEqual(parseCoordinates('91, 40'), { lng: 91, lat: 40, kind: 'decimal' }); // 91 cannot be a latitude, so it is the longitude
    assert.equal(parseCoordinates('38.2288 N, 40.1 N'), null);
    assert.equal(parseCoordinates('38.2288, 200.5'), null);
    assert.equal(parseCoordinates('38.2288'), null);
  });
});

describe('describeCoordinates', () => {
  it('writes them back to five places', () => {
    assert.equal(describeCoordinates({ lat: 38.2288, lng: -85.7878, kind: 'decimal' }), '38.22880, -85.78780');
  });
});
