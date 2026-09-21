import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportName, toGeoJson } from '../src/draw-export.ts';
import type { DrawFeature } from '../src/draw-model.ts';

const feature = (over: Partial<DrawFeature> & Pick<DrawFeature, 'kind' | 'coordinates'>): DrawFeature => ({
  id: over.id ?? 'id-1', properties: { label: 'A "quoted" name', notes: 'two\nlines, ünïcode ✓', color: '#1e88e5' }, createdAt: '2026-09-20T12:00:00.000Z', ...over,
});

describe('GeoJSON', () => {
  const all: DrawFeature[] = [
    feature({ id: 'p', kind: 'point', coordinates: [[-85.7, 38.2]] }),
    feature({ id: 't', kind: 'text', coordinates: [[-85.6, 38.3]] }),
    feature({ id: 'l', kind: 'line', coordinates: [[-85.7, 38.2], [-85.6, 38.3]] }),
    feature({ id: 'g', kind: 'polygon', coordinates: [[0, 0], [1, 0], [1, 1]] }),
    feature({ id: 'r', kind: 'rectangle', coordinates: [[0, 0], [1, 0], [1, 1], [0, 1]] }),
    feature({ id: 'c', kind: 'circle', coordinates: [[-85.7, 38.2]], radiusM: 250 }),
  ];
  const collection = toGeoJson(all);

  it('is a FeatureCollection with one feature for each, in order, with the id both ways', () => {
    assert.equal(collection.type, 'FeatureCollection');
    assert.deepEqual(collection.features.map((f) => f.id), ['p', 't', 'l', 'g', 'r', 'c']);
    for (const f of collection.features) assert.equal(f.properties.id, f.id);
  });

  it('gives each kind the right geometry, longitude first', () => {
    const geometry = Object.fromEntries(collection.features.map((f) => [f.id, f.geometry]));
    assert.deepEqual(geometry['p'], { type: 'Point', coordinates: [-85.7, 38.2] });
    assert.deepEqual(geometry['t'], { type: 'Point', coordinates: [-85.6, 38.3] });
    assert.equal(geometry['l']!.type, 'LineString');
    for (const id of ['g', 'r', 'c']) assert.equal(geometry[id]!.type, 'Polygon');
  });

  it('closes polygon rings, and draws a circle as 64 sides carrying its radius', () => {
    const rectangle = collection.features.find((f) => f.id === 'r')!.geometry as { coordinates: number[][][] };
    assert.equal(rectangle.coordinates[0]!.length, 5);
    assert.deepEqual(rectangle.coordinates[0]![0], rectangle.coordinates[0]![4]);
    const circle = collection.features.find((f) => f.id === 'c')!;
    assert.equal((circle.geometry as { coordinates: number[][][] }).coordinates[0]!.length, 65);
    assert.equal(circle.properties.radius_m, 250);
    assert.equal(collection.features.find((f) => f.id === 'p')!.properties.radius_m, null);
  });

  it('carries the kind, label, notes, colour and time, and survives a round trip through JSON text', () => {
    const back = JSON.parse(JSON.stringify(collection)) as typeof collection;
    assert.deepEqual(back, collection);
    const p = back.features[0]!.properties;
    assert.deepEqual(p, { id: 'p', kind: 'point', label: 'A "quoted" name', notes: 'two\nlines, ünïcode ✓', color: '#1e88e5', radius_m: null, created: '2026-09-20T12:00:00.000Z' });
  });

  it('is an empty collection for an empty drawing', () => {
    assert.deepEqual(toGeoJson([]), { type: 'FeatureCollection', features: [] });
  });
});

describe('file names', () => {
  it('carry the date and time, so two exports never collide, and the extension asked for', () => {
    assert.equal(exportName('geojson', new Date(2026, 8, 20, 9, 5, 7)), 'drawing-20260920-090507.geojson');
    assert.equal(exportName('gpkg', new Date(2026, 0, 2, 13, 4, 5)), 'drawing-20260102-130405.gpkg');
  });
});
