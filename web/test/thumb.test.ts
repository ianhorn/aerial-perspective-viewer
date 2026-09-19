import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitInside } from '../src/thumb.ts';

describe('fitInside', () => {
  it('scales a landscape photo to the width of the box', () => {
    assert.deepEqual(fitInside(1287, 962, 96, 72), { width: 96, height: 72 });
    assert.deepEqual(fitInside(442, 330, 192, 144), { width: 192, height: 143 });
  });

  it('scales a portrait photo to the height of the box', () => {
    assert.deepEqual(fitInside(330, 442, 96, 72), { width: 54, height: 72 });
    assert.deepEqual(fitInside(241, 322, 96, 72), { width: 54, height: 72 });
  });

  it('never enlarges a small picture', () => {
    assert.deepEqual(fitInside(60, 40, 96, 72), { width: 60, height: 40 });
  });

  it('never returns a zero side', () => {
    assert.deepEqual(fitInside(10000, 10, 96, 72), { width: 96, height: 1 });
  });
});
