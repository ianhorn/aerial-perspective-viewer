import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LonLat } from '../src/pc-aoi.ts';
import { AreaPicker } from '../src/pc-pick.ts';

// A flat map: 1,000 pixels to a degree, north up.
const view = {
  project: ([lon, lat]: LonLat) => ({ x: (lon + 85) * 1000, y: -(lat - 38) * 1000 }),
  unproject: ({ x, y }: { x: number; y: number }): LonLat => [-85 + x / 1000, 38 - y / 1000],
};

describe('picking an area', () => {
  const setup = () => {
    const picked: LonLat[][] = [];
    let changes = 0;
    const picker = new AreaPicker(view, (r) => picked.push(r), () => changes++);
    return { picker, picked, changes: () => changes };
  };

  it('does nothing until started', () => {
    const { picker, picked } = setup();
    picker.click({ x: 10, y: 10 });
    picker.click({ x: 200, y: 200 });
    assert.equal(picked.length, 0);
    assert.equal(picker.active, false);
    assert.equal(picker.cancel(), false);
  });

  it('two clicks make a rectangle of the four corners on the screen, in order, and stop picking', () => {
    const { picker, picked } = setup();
    picker.start();
    assert.match(picker.prompt, /one corner/);
    picker.click({ x: 100, y: 100 });
    assert.match(picker.prompt, /opposite corner/);
    picker.click({ x: 300, y: 250 });
    assert.equal(picked.length, 1);
    assert.equal(picker.active, false);
    const px = picked[0]!.map(([lon, lat]) => [Math.round((lon + 85) * 1000), Math.round(-(lat - 38) * 1000)]);
    assert.deepEqual(px, [[100, 100], [300, 100], [300, 250], [100, 250]]);
  });

  it('shows the rectangle following the pointer, and only once it has some size', () => {
    const { picker } = setup();
    picker.start();
    assert.equal(picker.preview(), null);
    picker.click({ x: 100, y: 100 });
    picker.move({ x: 100, y: 100 });
    assert.equal(picker.preview(), null);
    picker.move({ x: 180, y: 160 });
    assert.equal(picker.preview()!.length, 4);
  });

  it('ignores a second click that is too close to the first, and says why', () => {
    const { picker, picked } = setup();
    picker.start();
    picker.click({ x: 100, y: 100 });
    picker.click({ x: 103, y: 300 });
    assert.equal(picked.length, 0);
    assert.equal(picker.active, true);
    assert.match(picker.notice!, /farther/);
    picker.click({ x: 300, y: 300 });
    assert.equal(picked.length, 1);
    assert.equal(picker.notice, null);
  });

  it('can be cancelled at any point, and started again cleanly', () => {
    const { picker, picked } = setup();
    picker.start();
    picker.click({ x: 100, y: 100 });
    assert.equal(picker.cancel(), true);
    assert.equal(picker.active, false);
    assert.equal(picker.preview(), null);
    picker.start();
    picker.click({ x: 500, y: 500 }); // a fresh first corner, not the old one
    picker.click({ x: 600, y: 600 });
    assert.deepEqual(picked[0]![0]!.map((v) => Math.round(v * 1000)), [-85000 + 500, 38000 - 500]);
  });

  it('tells the page when it changes, so the outline can be redrawn', () => {
    const { picker, changes } = setup();
    picker.start();
    picker.click({ x: 100, y: 100 });
    picker.move({ x: 150, y: 150 });
    picker.cancel();
    assert.ok(changes() >= 4);
  });
});
