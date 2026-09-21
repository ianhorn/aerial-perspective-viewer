import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DrawFeature } from '../src/draw-model.ts';
import { edgeAt, handleAt, handlesOf, hitTest, type Project } from '../src/draw-hit.ts';
import { circleRing } from '../src/draw-geometry.ts';

// A flat projection, 1 degree = 100 pixels, north up, so the arithmetic is easy to follow.
const project: Project = ([lon, lat]) => ({ x: lon * 100, y: -lat * 100 });
const make = (id: string, kind: DrawFeature['kind'], coordinates: [number, number][], extra: Partial<DrawFeature> = {}): DrawFeature =>
  ({ id, kind, coordinates, properties: { label: '', notes: '', color: '#e53935' }, createdAt: '', ...extra });
const px = (lon: number, lat: number) => project([lon, lat]);

describe('what is under the pointer', () => {
  const point = make('pt', 'point', [[1, 1]]);
  const line = make('ln', 'line', [[0, 0], [3, 0]]);
  const big = make('big', 'polygon', [[0, 0], [4, 0], [4, 4], [0, 4]]);
  const small = make('small', 'polygon', [[1, 1], [2, 1], [2, 2], [1, 2]]);

  it('finds a point within a few pixels and not further', () => {
    assert.equal(hitTest([point], { x: 100 + 5, y: -100 + 4 }, project), 'pt');
    assert.equal(hitTest([point], { x: 100 + 20, y: -100 }, project), null);
  });

  it('finds a line near it, along its whole length, and not past its ends', () => {
    assert.equal(hitTest([line], { x: 150, y: 6 }, project), 'ln');
    assert.equal(hitTest([line], { x: 150, y: 30 }, project), null);
    assert.equal(hitTest([line], { x: 330, y: 0 }, project), null);
  });

  it('finds a shape by its inside or its edge, and nothing outside it', () => {
    assert.equal(hitTest([big], { x: 200, y: -200 }, project), 'big');
    assert.equal(hitTest([big], { x: 404, y: -200 }, project), 'big'); // just outside the edge, within reach
    assert.equal(hitTest([big], { x: 450, y: -200 }, project), null);
  });

  it('prefers a point to a line to a shape, and the smaller of two shapes', () => {
    assert.equal(hitTest([big, small, line, point], { x: 100, y: -100 }, project), 'pt');
    assert.equal(hitTest([big, small], { x: 150, y: -150 }, project), 'small');
    assert.equal(hitTest([small, big], { x: 150, y: -150 }, project), 'small'); // whichever was drawn first
    assert.equal(hitTest([big, line], { x: 150, y: 2 }, project), 'ln'); // on a line that lies along the shape's edge
    assert.equal(hitTest([big, small], { x: 350, y: -350 }, project), 'big'); // inside only the big one
    const across = make('across', 'line', [[1, 2], [3, 2]]); // a line drawn across the inside of the big shape
    assert.equal(hitTest([big, across], { x: 200, y: -200 }, project), 'across'); // on the line, so the line and not the shape under it
    assert.equal(hitTest([across, big], { x: 200, y: -230 }, project), 'big'); // 30 px off the line, so the shape
  });

  it('finds a circle by its ring, and finds nothing in an empty drawing', () => {
    const c = make('c', 'circle', [[2, 2]], { radiusM: 20_000 });
    const ring = circleRing([2, 2], 20_000);
    const p = px(...ring[0]!);
    assert.equal(hitTest([c], { x: p.x + 3, y: p.y }, project), 'c');
    assert.equal(hitTest([], { x: 0, y: 0 }, project), null);
  });

  it('takes the tolerance it is given', () => {
    assert.equal(hitTest([line], { x: 150, y: 30 }, project, 40), 'ln');
  });
});

describe('handles', () => {
  it('are the vertices of a line, polygon or rectangle, and the point itself', () => {
    assert.deepEqual(handlesOf(make('a', 'line', [[0, 0], [1, 1]])).map((h) => [h.index, h.role]), [[0, 'vertex'], [1, 'vertex']]);
    assert.equal(handlesOf(make('b', 'polygon', [[0, 0], [1, 0], [1, 1]])).length, 3);
    assert.equal(handlesOf(make('c', 'point', [[5, 5]])).length, 1);
    assert.equal(handlesOf(make('d', 'text', [[5, 5]]))[0]!.role, 'vertex');
  });

  it('are, for a circle, its centre and a point on its edge', () => {
    const [centre, radius] = handlesOf(make('c', 'circle', [[2, 2]], { radiusM: 1000 }));
    assert.deepEqual([centre!.role, radius!.role], ['centre', 'radius']);
    assert.deepEqual(centre!.at, [2, 2]);
    assert.notDeepEqual(radius!.at, [2, 2]);
  });

  it('are grabbed by the nearest one within reach', () => {
    const handles = handlesOf(make('p', 'polygon', [[0, 0], [1, 0], [1, 1], [0, 1]]));
    assert.equal(handleAt(handles, { x: 102, y: 3 }, project)!.index, 1);
    assert.equal(handleAt(handles, { x: 50, y: -50 }, project), null);
    // two handles within reach: the nearer wins
    const close = handlesOf(make('q', 'line', [[0, 0], [0.1, 0]])); // 10 px apart
    assert.equal(handleAt(close, { x: 8, y: 0 }, project)!.index, 1);
  });
});

describe('the edge nearest a pixel', () => {
  const square: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  it('finds the edge, and where on it', () => {
    const found = edgeAt(square, true, { x: 50, y: 6 }, project)!;
    assert.equal(found.after, 0);
    assert.deepEqual([Math.round(found.at.x), Math.round(found.at.y)], [50, 0]);
  });
  it('a polygon has an edge closing it, and a line does not', () => {
    const near = { x: 3, y: -50 }; // beside the edge from the last vertex back to the first
    assert.equal(edgeAt(square, true, near, project)!.after, 3);
    assert.equal(edgeAt(square, false, near, project), null);
  });
  it('finds nothing far from every edge', () => assert.equal(edgeAt(square, true, { x: 500, y: 500 }, project), null));
  it('takes the nearest of two edges near a corner', () => {
    assert.equal(edgeAt(square, true, { x: 98, y: -20 }, project)!.after, 1); // nearer the side going up than the bottom
  });
});

describe('text is hit across its width', () => {
  const text = make('t', 'text', [[1, 1]], { properties: { label: 'A long caption here', notes: '', color: '#fff' } });
  it('at the ends of the writing, not only at its anchor', () => {
    assert.equal(hitTest([text], { x: 100 + 60, y: -100 + 5 }, project), 't'); // 19 characters: about 76 px each way
    assert.equal(hitTest([text], { x: 100 + 90, y: -100 }, project), null);
    assert.equal(hitTest([text], { x: 100, y: -100 + 20 }, project), null); // above or below the line of writing
  });
});
