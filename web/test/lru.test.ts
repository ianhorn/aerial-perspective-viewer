import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LruCache } from '../src/lru.ts';

describe('LruCache', () => {
  it('holds up to its capacity and drops the oldest first', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.get('c'), 3);
  });

  it('counts a read as a use, so the read entry survives', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3); // drops b, not a
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), undefined);
  });

  it('replaces a value without growing, and refreshes its place', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    assert.equal(cache.size, 2);
    cache.set('c', 3); // drops b
    assert.equal(cache.get('a'), 10);
    assert.equal(cache.get('b'), undefined);
  });

  it('refuses a capacity that makes no sense', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => new LruCache(bad), RangeError);
  });
});

describe('LruCache.clear', () => {
  it('forgets everything, and the cache works as new afterwards', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('a'), undefined);
    cache.set('c', 3);
    assert.equal(cache.get('c'), 3);
  });
});
