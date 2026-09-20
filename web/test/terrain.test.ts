import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTerrain, type TerrainGrid } from '../src/terrain.ts';

// A 4 by 3 patch of 50 ft cells whose corner is at (1000, 2000), with height 100 + 2 per cell across (east)
// and + 5 per cell up (north): a plane, so bilinear reading must be exact everywhere inside.
const plane = (cols = 4, rows = 3): TerrainGrid => ({
  cellSize: 50, lowerLeftX: 1000, lowerLeftY: 2000, noDataValue: -9999,
  value: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => 100 + 2 * c + 5 * r)),
});
const truth = (x: number, y: number): number => 100 + 2 * ((x - 1000) / 50 - 0.5) + 5 * ((y - 2000) / 50 - 0.5);

describe('createTerrain', () => {
  it('reads the height at a cell centre as that cell\'s value', () => {
    const t = createTerrain(plane());
    assert.equal(t.heightAt(1025, 2025), 100); // the first cell, bottom left
    assert.equal(t.heightAt(1125, 2025), 104); // two cells east: 100 + 2 * 2
    assert.equal(t.heightAt(1025, 2125), 110); // two cells north
    assert.equal(t.heightAt(1175, 2125), 116); // the last cell, top right: 100 + 6 + 10
  });

  it('runs rows from the bottom: a larger y is a later row', () => {
    const t = createTerrain(plane());
    assert.ok(t.heightAt(1100, 2130)! > t.heightAt(1100, 2020)!);
  });

  it('interpolates between cell centres, exactly for a plane', () => {
    const t = createTerrain(plane());
    for (const [x, y] of [[1030, 2040], [1090, 2110], [1140, 2060], [1060, 2075.5]]) {
      assert.ok(Math.abs(t.heightAt(x!, y!)! - truth(x!, y!)) < 1e-9, `${x},${y}`);
    }
  });

  it('holds the edge value in the outer half cell, and is null outside the patch', () => {
    const t = createTerrain(plane());
    assert.equal(t.heightAt(1001, 2001), 100); // within half a cell of the corner: the corner cell's value
    assert.equal(t.heightAt(999, 2050), null);
    assert.equal(t.heightAt(1201, 2050), null);
    assert.equal(t.heightAt(1100, 1999), null);
    assert.equal(t.heightAt(1100, 2151), null);
    assert.deepEqual(t.extent, { xMin: 1000, yMin: 2000, xMax: 1200, yMax: 2150 });
  });

  it('uses the cells that have data where one is missing, and is null when none has', () => {
    const grid = plane();
    grid.value[1]![1] = -9999;
    const t = createTerrain(grid);
    const h = t.heightAt(1075, 2075)!; // right on the missing cell's centre: taken from its neighbours
    assert.ok(h > 100 && h < 120);
    const empty = plane(2, 2);
    for (const row of empty.value) row.fill(-9999);
    assert.equal(createTerrain(empty).heightAt(1050, 2050), null);
  });

  it('refuses an empty or nonsensical patch', () => {
    assert.throws(() => createTerrain({ ...plane(), value: [] }), /empty/);
    assert.throws(() => createTerrain({ ...plane(), cellSize: 0 }), /empty/);
  });

  it('works on a single cell', () => {
    const t = createTerrain({ cellSize: 50, lowerLeftX: 0, lowerLeftY: 0, noDataValue: -9999, value: [[321]] });
    assert.equal(t.heightAt(10, 40), 321);
    assert.equal(t.heightAt(60, 10), null);
  });
});
