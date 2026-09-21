import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DrawStore } from '../src/draw-model.ts';
import { loadDrawing, saveDrawing, STORAGE_KEY, type Store } from '../src/draw-storage.ts';

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const drawn = () => {
  const store = new DrawStore(() => '2026-01-01T00:00:00.000Z');
  store.add({ kind: 'circle', coordinates: [[-85.7, 38.2]], radiusM: 250, properties: { label: 'Pond', notes: 'seen 2026', color: '#1e88e5' } });
  store.add({ kind: 'line', coordinates: [[-85.7, 38.2], [-85.6, 38.3]] });
  return store;
};

describe('keeping the drawing in the browser', () => {
  it('what is saved comes back, and passes through the store unchanged', () => {
    const storage = memory();
    const store = drawn();
    assert.equal(saveDrawing(storage, store.features), true);
    const again = new DrawStore();
    assert.equal(again.load(loadDrawing(storage)), 2);
    assert.deepEqual(again.features, store.features);
  });

  it('an empty, missing or unreadable save gives an empty drawing, not an error', () => {
    assert.deepEqual(loadDrawing(memory()), []);
    assert.deepEqual(loadDrawing(null), []);
    const storage = memory();
    storage.setItem(STORAGE_KEY, '{not json');
    assert.deepEqual(loadDrawing(storage), []);
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 99, features: [{ id: 'x' }] })); // a version this code does not know
    assert.deepEqual(loadDrawing(storage), []);
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, features: 'no' }));
    assert.deepEqual(loadDrawing(storage), []);
  });

  it('unusable features in a save are dropped when loaded, and the usable ones kept', () => {
    const storage = memory();
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, features: [{ id: 'bad', kind: 'line', coordinates: [[0, 0]] }, ...drawn().features] }));
    assert.equal(new DrawStore().load(loadDrawing(storage)), 2);
  });

  it('a storage that refuses (full, blocked) is reported, not thrown', () => {
    const full: Store = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    assert.equal(saveDrawing(full, drawn().features), false);
    assert.equal(saveDrawing(null, drawn().features), false);
    const broken: Store = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
    assert.deepEqual(loadDrawing(broken), []);
  });
});
