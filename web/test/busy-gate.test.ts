import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createBusyGate } from '../src/busy-gate.ts';

describe('createBusyGate', () => {
  let t = 0;
  let calls: boolean[] = [];
  const advance = (ms: number): void => {
    t += ms;
    mock.timers.tick(ms);
  };
  const make = () => createBusyGate({ showAfterMs: 300, minShownMs: 500, now: () => t }, (shown) => calls.push(shown));

  beforeEach(() => {
    t = 0;
    calls = [];
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => mock.timers.reset());

  it('stays hidden for work that finishes before the delay', () => {
    const gate = make();
    gate.set(true);
    advance(299);
    gate.set(false);
    advance(1000);
    assert.deepEqual(calls, []);
    assert.equal(gate.shown, false);
  });

  it('shows once the work has gone on for the delay', () => {
    const gate = make();
    gate.set(true);
    advance(299);
    assert.equal(gate.shown, false);
    advance(1);
    assert.deepEqual(calls, [true]);
    assert.equal(gate.shown, true);
  });

  it('hides at once when the work ends after the minimum time', () => {
    const gate = make();
    gate.set(true);
    advance(300);
    advance(500);
    gate.set(false);
    assert.deepEqual(calls, [true, false]);
  });

  it('keeps a shown indicator for its minimum time, then hides it', () => {
    const gate = make();
    gate.set(true);
    advance(300);
    advance(100); // shown for 100 ms
    gate.set(false);
    assert.deepEqual(calls, [true]);
    advance(399);
    assert.deepEqual(calls, [true]);
    advance(1);
    assert.deepEqual(calls, [true, false]);
    assert.equal(gate.shown, false);
  });

  it('does not restart the wait when told the same thing again', () => {
    const gate = make();
    gate.set(true);
    advance(200);
    gate.set(true);
    advance(100);
    assert.deepEqual(calls, [true]); // shown 300 ms after the first set, not the second
  });

  it('stays shown when work returns while it waits out its minimum', () => {
    const gate = make();
    gate.set(true);
    advance(300);
    gate.set(false);
    advance(100);
    gate.set(true);
    advance(2000);
    assert.deepEqual(calls, [true]);
    assert.equal(gate.shown, true);
    gate.set(false);
    assert.deepEqual(calls, [true, false]);
  });

  it('can show again after it has hidden', () => {
    const gate = make();
    gate.set(true);
    advance(300);
    advance(500);
    gate.set(false);
    gate.set(true);
    advance(300);
    assert.deepEqual(calls, [true, false, true]);
  });

  it('does nothing after dispose', () => {
    const gate = make();
    gate.set(true);
    gate.dispose();
    advance(1000);
    gate.set(false);
    assert.deepEqual(calls, []);
  });
});
