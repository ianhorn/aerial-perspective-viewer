import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampView, contains, deviceScale, fitSize, FIT, maxZoom, panBy, toPhoto, toScreen, visibleRegion, zoomAt, type View,
} from '../src/zoom.ts';

const stage = { w: 800, h: 600 };
const aspect = 4 / 3; // a landscape photo
const fit = fitSize(stage, aspect);
const MAX = 20;
const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

describe('fitSize', () => {
  it('fills the stage along the tighter side and keeps the photo\'s shape', () => {
    assert.deepEqual(fitSize({ w: 800, h: 600 }, 4 / 3), { w: 800, h: 600 });
    const wide = fitSize({ w: 1000, h: 600 }, 4 / 3); // stage wider than the photo: limited by the height
    near(wide.h, 600);
    near(wide.w, 800);
    const tall = fitSize({ w: 400, h: 600 }, 4 / 3); // limited by the width
    near(tall.w, 400);
    near(tall.h, 300);
    const portrait = fitSize({ w: 800, h: 600 }, 3 / 4); // a portrait photo (Left and Right cameras)
    near(portrait.h, 600);
    near(portrait.w, 450);
  });
});

describe('maxZoom', () => {
  it('lets a photo pixel be enlarged at most twice in device pixels, and is at least 1', () => {
    // a 10,300 px photo fitted to 800 px on a screen with pixel ratio 1: 2 * 10300 / 800 = 25.75
    near(maxZoom({ w: 800, h: 600 }, 10300, 1), 25.75);
    near(maxZoom({ w: 800, h: 600 }, 10300, 2), 12.875);
    near(maxZoom({ w: 800, h: 600 }, 500, 1), 1.25); // already shown enlarged, it has little room
    assert.equal(maxZoom({ w: 800, h: 600 }, 300, 1), 1); // a tiny photo cannot zoom at all
  });
});

describe('toScreen and toPhoto', () => {
  it('are inverses, at any view', () => {
    const view: View = { zoom: 3, cx: 0.3, cy: 0.6 };
    for (const p of [{ u: 0.1, v: 0.9 }, { u: 0.5, v: 0.5 }, { u: 0.75, v: 0.2 }]) {
      const back = toPhoto(view, toScreen(view, p, stage, fit), stage, fit);
      near(back.u, p.u);
      near(back.v, p.v);
    }
  });
  it('puts the centre of the view at the middle of the stage', () => {
    const s = toScreen({ zoom: 4, cx: 0.25, cy: 0.75 }, { u: 0.25, v: 0.75 }, stage, fit);
    near(s.x, 400);
    near(s.y, 300);
  });
});

describe('zoomAt', () => {
  it('keeps the point under the pointer where it is', () => {
    const anchor = { x: 620, y: 140 };
    const before = toPhoto(FIT, anchor, stage, fit);
    const zoomed = zoomAt(FIT, 4, anchor, stage, fit, MAX);
    near(zoomed.zoom, 4);
    const after = toScreen(zoomed, before, stage, fit);
    near(after.x, anchor.x, 1e-6);
    near(after.y, anchor.y, 1e-6);
  });
  it('is undone by the opposite zoom about the same place', () => {
    const anchor = { x: 300, y: 450 };
    const back = zoomAt(zoomAt(FIT, 3, anchor, stage, fit, MAX), 1 / 3, anchor, stage, fit, MAX);
    near(back.zoom, 1);
    near(back.cx, 0.5);
    near(back.cy, 0.5);
  });
  it('cannot zoom out past the whole photo or in past the maximum', () => {
    assert.equal(zoomAt(FIT, 0.1, { x: 400, y: 300 }, stage, fit, MAX).zoom, 1);
    assert.equal(zoomAt(FIT, 1000, { x: 400, y: 300 }, stage, fit, MAX).zoom, MAX);
  });
  it('keeps the photo covering the stage when zooming in at a corner', () => {
    const v = zoomAt(FIT, 4, { x: 0, y: 0 }, stage, fit, MAX);
    const corner = toScreen(v, { u: 0, v: 0 }, stage, fit);
    assert.ok(corner.x <= 1e-9 && corner.y <= 1e-9, `top left of the photo is on screen at ${corner.x}, ${corner.y}`);
    const far = toScreen(v, { u: 1, v: 1 }, stage, fit);
    assert.ok(far.x >= 800 - 1e-9 && far.y >= 600 - 1e-9);
  });
  it('zooms about the pointer with two fingers: the midpoint stays put as the fingers spread', () => {
    const midpoint = { x: 400, y: 300 };
    const spread = zoomAt(FIT, 250 / 100, midpoint, stage, fit, MAX);
    near(spread.zoom, 2.5);
    near(spread.cx, 0.5);
    near(spread.cy, 0.5);
  });
});

describe('panBy', () => {
  it('drags the photo with the pointer', () => {
    const zoomed: View = { zoom: 4, cx: 0.5, cy: 0.5 };
    const p = toPhoto(zoomed, { x: 400, y: 300 }, stage, fit);
    const moved = panBy(zoomed, 100, -50, stage, fit, MAX);
    const s = toScreen(moved, p, stage, fit);
    near(s.x, 500, 1e-6);
    near(s.y, 250, 1e-6);
  });
  it('cannot drag the photo off the stage', () => {
    const far = panBy({ zoom: 4, cx: 0.5, cy: 0.5 }, 1e6, 1e6, stage, fit, MAX);
    const corner = toScreen(far, { u: 0, v: 0 }, stage, fit);
    near(corner.x, 0, 1e-6);
    near(corner.y, 0, 1e-6);
  });
  it('does nothing to a photo that fits', () => {
    const v = panBy(FIT, 200, 200, stage, fit, MAX);
    assert.deepEqual(v, FIT);
  });
});

describe('clampView', () => {
  it('centres a photo that is smaller than the stage on that axis, and lets the other axis move', () => {
    const wideStage = { w: 1000, h: 600 };
    const wideFit = fitSize(wideStage, aspect); // 800 x 600
    const v = clampView({ zoom: 1.5, cx: 0.9, cy: 0.9 }, wideStage, wideFit, MAX); // 1200 x 900: wider than 1000 and taller than 600
    assert.ok(v.cx < 0.9 && v.cy < 0.9);
    const still = clampView({ zoom: 1.0, cx: 0.2, cy: 0.9 }, wideStage, wideFit, MAX); // 800 wide in 1000: centred; full height: centred
    assert.equal(still.cx, 0.5);
    assert.equal(still.cy, 0.5);
  });
});

describe('visibleRegion', () => {
  it('is the whole photo when it is fitted', () => {
    assert.deepEqual(visibleRegion(FIT, stage, fit), { u0: 0, v0: 0, u1: 1, v1: 1 });
  });
  it('shrinks with the zoom, around the centre', () => {
    const r = visibleRegion({ zoom: 4, cx: 0.5, cy: 0.5 }, stage, fit);
    near(r.u0, 0.375);
    near(r.u1, 0.625);
    near(r.v0, 0.375);
    near(r.v1, 0.625);
  });
  it('grows by a margin on each side and is clipped to the photo', () => {
    const r = visibleRegion({ zoom: 4, cx: 0.5, cy: 0.5 }, stage, fit, 0.25);
    near(r.u0, 0.3125);
    near(r.u1, 0.6875);
    const edge = visibleRegion({ zoom: 4, cx: 0.125, cy: 0.5 }, stage, fit, 0.5);
    assert.equal(edge.u0, 0);
  });
});

describe('deviceScale and contains', () => {
  it('counts device pixels per full-size photo pixel', () => {
    near(deviceScale(FIT, fit, 10300, 1), 800 / 10300);
    near(deviceScale({ zoom: 4, cx: 0.5, cy: 0.5 }, fit, 10300, 2), (800 * 4 * 2) / 10300);
  });
  it('tells whether one region lies inside another', () => {
    const outer = { u0: 0.2, v0: 0.2, u1: 0.8, v1: 0.8 };
    assert.ok(contains(outer, { u0: 0.3, v0: 0.3, u1: 0.7, v1: 0.7 }));
    assert.ok(!contains(outer, { u0: 0.1, v0: 0.3, u1: 0.7, v1: 0.7 }));
  });
});
