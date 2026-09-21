import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COLOURS, DEFAULT_COLOUR, DrawStore, problemWith, repair } from '../src/draw-model.ts';

const P = (lon: number, lat: number): [number, number] => [lon, lat];
const line = { kind: 'line' as const, coordinates: [P(-85.7, 38.2), P(-85.6, 38.3)] };
const square = { kind: 'polygon' as const, coordinates: [P(-85.7, 38.2), P(-85.6, 38.2), P(-85.6, 38.3), P(-85.7, 38.3)] };

describe('adding features', () => {
  it('gives each an id, a time and default properties, and keeps them in order', () => {
    const store = new DrawStore(() => '2026-09-20T12:00:00.000Z');
    const a = store.add({ kind: 'point', coordinates: [P(-85.7, 38.2)] });
    const b = store.add(line);
    assert.notEqual(a.id, b.id);
    assert.equal(a.createdAt, '2026-09-20T12:00:00.000Z');
    assert.deepEqual(a.properties, { label: '', notes: '', color: DEFAULT_COLOUR });
    assert.deepEqual(store.features.map((f) => f.id), [a.id, b.id]);
    assert.ok(COLOURS.includes(DEFAULT_COLOUR as (typeof COLOURS)[number]));
  });

  it('takes the properties it is given, and keeps the rest as defaults', () => {
    const store = new DrawStore();
    const f = store.add({ ...square, properties: { label: 'Lot 4', color: '#1e88e5' } });
    assert.deepEqual(f.properties, { label: 'Lot 4', notes: '', color: '#1e88e5' });
  });

  it('refuses a shape that cannot be one: too few or too many vertices, a bad vertex, a circle with no radius', () => {
    const store = new DrawStore();
    assert.throws(() => store.add({ kind: 'line', coordinates: [P(-85, 38)] }), /cannot have 1 vertices/);
    assert.throws(() => store.add({ kind: 'polygon', coordinates: [P(-85, 38), P(-84, 38)] }), /cannot have 2 vertices/);
    assert.throws(() => store.add({ kind: 'point', coordinates: [P(-85, 38), P(-84, 38)] }), /cannot have 2 vertices/);
    assert.throws(() => store.add({ kind: 'point', coordinates: [[NaN, 38]] }), /not a pair of numbers/);
    assert.throws(() => store.add({ kind: 'point', coordinates: [[-85, 95]] }), /outside the world/);
    assert.throws(() => store.add({ kind: 'circle', coordinates: [P(-85, 38)] }), /radius/);
    assert.throws(() => store.add({ kind: 'circle', coordinates: [P(-85, 38)], radiusM: -3 }), /radius/);
    assert.equal(store.features.length, 0);
  });
});

describe('changing and removing', () => {
  it('changes properties, vertices and radius, and says whether the feature was there', () => {
    const store = new DrawStore();
    const f = store.add(square);
    assert.equal(store.update(f.id, { properties: { label: 'Yard' } }), true);
    assert.equal(store.get(f.id)!.properties.label, 'Yard');
    assert.equal(store.get(f.id)!.properties.color, DEFAULT_COLOUR); // the rest kept
    store.update(f.id, { coordinates: [P(-85.7, 38.2), P(-85.5, 38.2), P(-85.5, 38.4)] });
    assert.equal(store.get(f.id)!.coordinates.length, 3);
    assert.equal(store.update('nope', { properties: { label: 'x' } }), false);
    assert.equal(store.remove('nope'), false);
    assert.equal(store.remove(f.id), true);
    assert.equal(store.features.length, 0);
  });

  it('refuses a change that would make the feature unusable, and leaves it as it was', () => {
    const store = new DrawStore();
    const f = store.add(line);
    assert.throws(() => store.update(f.id, { coordinates: [P(-85, 38)] }));
    assert.equal(store.get(f.id)!.coordinates.length, 2);
    assert.equal(store.canUndo, true); // only the add is in the history
    store.undo();
    assert.equal(store.features.length, 0);
  });

  it('turns a rectangle into a polygon when asked (a moved corner stops it being a rectangle)', () => {
    const store = new DrawStore();
    const r = store.add({ kind: 'rectangle', coordinates: [P(0, 0), P(1, 0), P(1, 1), P(0, 1)] });
    store.update(r.id, { kind: 'polygon', coordinates: [P(0, 0), P(1, 0), P(1.2, 1), P(0, 1)] });
    assert.equal(store.get(r.id)!.kind, 'polygon');
  });
});

describe('undo and redo', () => {
  it('goes back and forward over adds, changes and removals, one step each', () => {
    const store = new DrawStore();
    const a = store.add({ kind: 'point', coordinates: [P(-85.7, 38.2)] });
    store.update(a.id, { properties: { label: 'one' } });
    const b = store.add(line);
    store.remove(a.id);
    assert.deepEqual(store.features.map((f) => f.id), [b.id]);
    store.undo(); // the removal
    assert.deepEqual(store.features.map((f) => f.id), [a.id, b.id]);
    store.undo(); // the second add
    assert.deepEqual(store.features.map((f) => f.id), [a.id]);
    store.undo(); // the label
    assert.equal(store.get(a.id)!.properties.label, '');
    store.undo(); // the first add
    assert.equal(store.features.length, 0);
    assert.equal(store.undo(), false);
    store.redo();
    store.redo();
    assert.equal(store.get(a.id)!.properties.label, 'one');
    store.redo();
    store.redo();
    assert.deepEqual(store.features.map((f) => f.id), [b.id]);
    assert.equal(store.redo(), false);
  });

  it('forgets what could be redone once something new is done', () => {
    const store = new DrawStore();
    store.add(line);
    store.undo();
    assert.equal(store.canRedo, true);
    store.add(square);
    assert.equal(store.canRedo, false);
  });

  it('does not let a later change reach into what was saved for undo', () => {
    const store = new DrawStore();
    const f = store.add(line);
    store.update(f.id, { coordinates: [P(1, 1), P(2, 2)] });
    store.undo();
    assert.deepEqual(store.get(f.id)!.coordinates, [P(-85.7, 38.2), P(-85.6, 38.3)]);
  });

  it('undoes clearing the whole drawing in one step, and keeps only the last 100 steps', () => {
    const store = new DrawStore();
    store.add(line);
    store.add(square);
    store.clear();
    assert.equal(store.features.length, 0);
    store.undo();
    assert.equal(store.features.length, 2);
    const many = new DrawStore();
    for (let i = 0; i < 150; i++) many.add({ kind: 'point', coordinates: [P(-85, 38)] });
    let undone = 0;
    while (many.undo()) undone++;
    assert.equal(undone, 100);
    assert.equal(many.features.length, 50);
  });
});

describe('loading and repairing', () => {
  it('loads usable features, drops the rest, fills in what an older save lacks, and starts the history again', () => {
    const store = new DrawStore();
    store.add(line);
    const count = store.load([
      { id: 'a', kind: 'point', coordinates: [[-85.7, 38.2]], properties: { label: 'kept', color: 'not a colour' } },
      { id: 'b', kind: 'polygon', coordinates: [[0, 0], [1, 1]], properties: {} }, // too few vertices
      { kind: 'point', coordinates: [[0, 0]] }, // no id
      'nonsense',
      null,
      { id: 'c', kind: 'circle', coordinates: [[-85, 38]], radiusM: 50 },
    ]);
    assert.equal(count, 2);
    assert.deepEqual(store.features.map((f) => f.id), ['a', 'c']);
    assert.deepEqual(store.get('a')!.properties, { label: 'kept', notes: '', color: DEFAULT_COLOUR });
    assert.equal(store.canUndo, false);
    assert.equal(repair({ id: 'z', kind: 'text', coordinates: [[1, 2]] })!.properties.label, '');
  });

  it('says why a feature cannot be used', () => {
    assert.match(problemWith(null)!, /not an object/);
    assert.match(problemWith({ id: 'x', kind: 'blob', coordinates: [], properties: {} })!, /unknown kind blob/);
    assert.equal(problemWith({ id: 'x', kind: 'point', coordinates: [[1, 2]], properties: {} }), null);
  });
});

describe('subscribers', () => {
  it('are told of every change, and stop when they unsubscribe', () => {
    const store = new DrawStore();
    let n = 0;
    const off = store.subscribe(() => n++);
    const f = store.add(line);
    store.update(f.id, { properties: { label: 'x' } });
    store.undo();
    store.redo();
    store.remove(f.id);
    store.clear(); // nothing to clear: no change
    store.load([]);
    assert.equal(n, 6);
    off();
    store.add(line);
    assert.equal(n, 6);
  });
});
