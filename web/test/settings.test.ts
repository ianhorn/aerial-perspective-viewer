import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Store } from '../src/draw-storage.ts';
import { DEFS, defaults, fit, KEYS, pcLimits, Settings, SETTINGS_KEY } from '../src/settings.ts';

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe('bringing a value inside a setting', () => {
  it('clamps to the smallest and largest', () => {
    assert.equal(fit('pcAreaSqMi', 0), 0.25);
    assert.equal(fit('pcAreaSqMi', 100), 8);
    assert.equal(fit('pcTotalMillions', -5), 2);
    assert.equal(fit('pcClipPercent', 50), 10);
  });

  it('snaps to the step, counted from the smallest, without float dust', () => {
    assert.equal(fit('pcAreaSqMi', 3.9), 4); // steps of 0.25 from 0.25: 3.75 and 4
    assert.equal(fit('pcAreaSqMi', 3.8), 3.75);
    assert.equal(fit('pcSizeScale', 1.13), 1.15); // steps of 0.05 from 0.3
    assert.equal(fit('pcSizeScale', 0.1 + 0.2 + 1), 1.3); // 1.3000000000000003 is not what is held
    assert.equal(fit('pcTargetPx', 3.3), 3.5); // steps of 0.5 from 1
    assert.equal(fit('photosAtATime', 6.4), 6);
    assert.equal(fit('pcLoadMb', 30), 32); // steps of 8 from 8: 24, 32
  });

  it('is never outside the range after snapping, at either end', () => {
    for (const key of KEYS) {
      const d = DEFS[key];
      assert.ok(fit(key, d.min - 1) >= d.min && fit(key, d.max + 1) <= d.max, key);
      assert.equal(fit(key, d.max), d.max);
      assert.equal(fit(key, d.min), d.min);
    }
  });

  it('takes the default for anything that is not a number', () => {
    for (const bad of [NaN, Infinity, '5', null, undefined, {}, [3]]) assert.equal(fit('pcAreaSqMi', bad), DEFS.pcAreaSqMi.default);
  });

  it('every default is inside its own range and step', () => {
    for (const key of KEYS) assert.equal(fit(key, DEFS[key].default), DEFS[key].default, key);
  });
});

describe('the settings held', () => {
  it('start at the defaults, and change and tell those who listen', () => {
    const s = new Settings(memory());
    assert.deepEqual(s.all(), defaults());
    assert.equal(s.changed, false);
    let told = 0;
    s.subscribe(() => told++);
    assert.equal(s.set('pcAreaSqMi', 2), 2);
    assert.equal(s.get('pcAreaSqMi'), 2);
    assert.equal(s.changed, true);
    assert.equal(s.isDefault('pcAreaSqMi'), false);
    assert.equal(told, 1);
    s.set('pcAreaSqMi', 2); // no change: nothing to tell
    assert.equal(told, 1);
  });

  it('brings what is set inside the range', () => {
    const s = new Settings(memory());
    assert.equal(s.set('pcTotalMillions', 500), 20);
    assert.equal(s.get('pcTotalMillions'), 20);
  });

  it('are kept, only the ones that differ from the default, and come back', () => {
    const storage = memory();
    const s = new Settings(storage);
    s.set('pcTargetPx', 5);
    s.set('photosAtATime', 8);
    assert.deepEqual(JSON.parse(storage.data.get(SETTINGS_KEY)!), { version: 1, values: { pcTargetPx: 5, photosAtATime: 8 } });
    const again = new Settings(storage);
    assert.equal(again.get('pcTargetPx'), 5);
    assert.equal(again.get('photosAtATime'), 8);
    assert.equal(again.get('pcAreaSqMi'), 4);
  });

  it('put back to the default one at a time, or all together, and the storage follows', () => {
    const storage = memory();
    const s = new Settings(storage);
    s.set('pcTargetPx', 5);
    s.set('photosAtATime', 8);
    s.reset('pcTargetPx');
    assert.equal(s.get('pcTargetPx'), 3);
    assert.deepEqual(JSON.parse(storage.data.get(SETTINGS_KEY)!).values, { photosAtATime: 8 });
    s.reset();
    assert.equal(s.changed, false);
    assert.deepEqual(JSON.parse(storage.data.get(SETTINGS_KEY)!).values, {});
  });

  it('cope with a store that is corrupt, of another version, out of range, or holds keys it does not know', () => {
    for (const text of ['{nope', '[]', '"x"', 'null', JSON.stringify({ version: 99, values: { pcAreaSqMi: 2 } }), JSON.stringify({ version: 1, values: 5 })]) {
      const storage = memory();
      storage.data.set(SETTINGS_KEY, text);
      assert.deepEqual(new Settings(storage).all(), defaults(), text);
    }
    const storage = memory();
    storage.data.set(SETTINGS_KEY, JSON.stringify({ version: 1, values: { pcAreaSqMi: 9999, pcTargetPx: 'lots', photosAtATime: 7.2, gone: 1 } }));
    const s = new Settings(storage);
    assert.equal(s.get('pcAreaSqMi'), 8); // brought to the largest
    assert.equal(s.get('pcTargetPx'), 3); // not a number: the default
    assert.equal(s.get('photosAtATime'), 7);
    assert.equal('gone' in s.all(), false);
  });

  it('still work when the browser will not keep them', () => {
    const refuse: Store = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    const s = new Settings(refuse);
    assert.equal(s.set('pcAreaSqMi', 1), 1);
    assert.equal(s.get('pcAreaSqMi'), 1);
    assert.equal(new Settings(null).set('pcTargetPx', 2), 2);
  });
});

describe('the point cloud limits, in the units the code uses', () => {
  it('turn millions into points, MB into bytes, and percent into a fraction (worked out by hand)', () => {
    const s = new Settings(memory());
    assert.deepEqual(pcLimits(s), { areaSqMi: 4, budget: { maxPoints: 4_000_000, maxBytes: 33_554_432 }, maxTotalPoints: 12_000_000, targetPx: 3, clip: 0.02, sizeScale: 1.15, maxSizePx: 14 });
    s.set('pcLoadMillions', 1.5);
    s.set('pcLoadMb', 16);
    s.set('pcTotalMillions', 6);
    s.set('pcClipPercent', 5);
    const l = pcLimits(s);
    assert.equal(l.budget.maxPoints, 1_500_000);
    assert.equal(l.budget.maxBytes, 16_777_216);
    assert.equal(l.maxTotalPoints, 6_000_000);
    assert.equal(l.clip, 0.05);
  });
});
