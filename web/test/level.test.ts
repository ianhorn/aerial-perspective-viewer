import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bingLevel, compareToNative, describeScale, formatScale, mapScale, NATIVE_SCALE } from '../src/level-control.ts';

// Where 1:256 falls at Louisville's latitude: MapLibre zoom 19.792, which is level 20.79.
const NATIVE_ZOOM_AT_38 = 19.792;

describe('zoom level in the Bing/Google numbering', () => {
  it('is one above the MapLibre zoom, which counts with 512 px tiles', () => {
    // Checked against the basemap requests: camera zoom 12, 15, 18 and 19 fetched tile levels 13, 16, 19 and 20.
    assert.equal(bingLevel(12), 13);
    assert.equal(bingLevel(15), 16);
    assert.equal(bingLevel(19), 20);
  });
});

describe('mapScale', () => {
  it('matches the scales Bing publishes for the equator (96 dpi)', () => {
    assert.ok(Math.abs(mapScale(20, 0) - 282.1) < 0.2, `level 21 is ${mapScale(20, 0)}`); // Bing: 1:282
    assert.ok(Math.abs(mapScale(19, 0) - 564.2) < 0.3); // Bing: 1:564
    assert.ok(Math.abs(mapScale(0, 0) - 295_829_355) < 1000); // level 1, twice the world
  });

  it('is finer away from the equator, by the cosine of the latitude', () => {
    assert.ok(Math.abs(mapScale(20, 38.24) / mapScale(20, 0) - Math.cos((38.24 * Math.PI) / 180)) < 1e-9);
    assert.equal(Math.round(mapScale(20, 38.24)), 222); // level 21 at Louisville
    assert.equal(Math.round(mapScale(19, 38.24)), 443); // level 20, where the state's basemap tiles stop
  });

  it('puts 1:256 (native resolution) at level 20.8 across Kentucky', () => {
    // MapLibre zoom at which the scale is 1:256, worked out separately in Python for the state's south, middle and north.
    for (const [lat, zoom] of [[36.6, 19.823], [38.24, 19.792], [39.1, 19.774]] as const) {
      assert.ok(Math.abs(mapScale(zoom, lat) - NATIVE_SCALE) < 0.5, `${lat}: ${mapScale(zoom, lat)}`);
    }
  });
});

describe('compareToNative', () => {
  it('calls scales within 5% of 1:256 native, coarser ones coarser, closer ones enlarged', () => {
    assert.equal(compareToNative(256).state, 'native');
    assert.equal(compareToNative(245).state, 'native');
    assert.equal(compareToNative(268).state, 'native');
    assert.equal(compareToNative(443).state, 'coarser');
    assert.equal(compareToNative(1128).state, 'coarser');
    assert.equal(compareToNative(222).state, 'enlarged');
    assert.equal(compareToNative(128).state, 'enlarged');
  });

  it('says by how much a closer scale enlarges the photo', () => {
    assert.equal(compareToNative(128).enlargement, 2);
    assert.ok(Math.abs(compareToNative(222).enlargement - 1.153) < 0.001);
  });
});

describe('describeScale', () => {
  it('shows level and scale only while coarser than native', () => {
    assert.deepEqual(describeScale(14, 38.24), { text: 'Level 15.0 · 1:14,182', state: 'coarser' });
    assert.equal(describeScale(19, 38.24).text, 'Level 20.0 · 1:443'); // the basemap's last level
  });

  it('says native at 1:256', () => {
    assert.deepEqual(describeScale(NATIVE_ZOOM_AT_38, 38.24), { text: 'Level 20.8 · 1:256 · native', state: 'native' });
  });

  it('says how much it is enlarged when closer than native', () => {
    assert.deepEqual(describeScale(20, 38.24), { text: 'Level 21.0 · 1:222 · enlarged 1.2×', state: 'enlarged' });
    assert.deepEqual(describeScale(20.792, 38.24), { text: 'Level 21.8 · 1:128 · enlarged 2.0×', state: 'enlarged' });
  });

  it('formats scales with thousands separators', () => {
    assert.equal(formatScale(1128.4), '1:1,128');
    assert.equal(formatScale(256), '1:256');
    assert.equal(formatScale(295_829_355), '1:295,829,355');
  });
});
