import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DrawStore, type DrawFeature } from '../src/draw-model.ts';
import { DrawController, promptFor, type View } from '../src/draw-tool.ts';
import { groundDistanceM, type LonLat } from '../src/draw-geometry.ts';

// A flat map: 1 degree = 1000 pixels, north up, so a pixel is 0.001 degree and the arithmetic is easy to follow.
const ORIGIN: LonLat = [-85, 38];
const view: View = {
  project: ([lon, lat]) => ({ x: (lon - ORIGIN[0]) * 1000, y: -(lat - ORIGIN[1]) * 1000 }),
  unproject: ({ x, y }) => [ORIGIN[0] + x / 1000, ORIGIN[1] - y / 1000],
};
const setup = () => {
  const store = new DrawStore(() => '2026-01-01T00:00:00.000Z');
  const created: DrawFeature[] = [];
  const tool = new DrawController(store, view, { onCreate: (f) => created.push(f) });
  return { store, tool, created };
};
const px = (x: number, y: number) => ({ x, y });
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

describe('choosing a tool', () => {
  it('starts off, and a tool can be turned on and off', () => {
    const { tool } = setup();
    assert.equal(tool.active, false);
    tool.setTool('line');
    assert.equal(tool.active, true);
    tool.setTool(null);
    assert.equal(tool.active, false);
  });

  it('does nothing with a click while off', () => {
    const { tool, store } = setup();
    tool.click(px(10, 10));
    assert.equal(store.features.length, 0);
  });

  it('drops a half-drawn shape and the selection when the tool changes, but keeps the selection for Select', () => {
    const { tool, store } = setup();
    tool.setTool('point');
    tool.click(px(10, 10));
    const id = tool.selected!;
    tool.setTool('select');
    assert.equal(tool.selected, id);
    tool.setTool('line');
    assert.equal(tool.selected, null);
    tool.click(px(0, 0));
    assert.ok(tool.draft);
    tool.setTool('polygon');
    assert.equal(tool.draft, null);
    assert.equal(store.features.length, 1);
  });

  it('says what to do next for every tool and step', () => {
    for (const t of ['select', 'point', 'line', 'polygon', 'rectangle', 'circle', 'text'] as const) {
      assert.ok(promptFor(t, 0).length > 10);
    }
    assert.notEqual(promptFor('line', 0), promptFor('line', 1));
    assert.notEqual(promptFor('rectangle', 0), promptFor('rectangle', 1));
    assert.notEqual(promptFor('circle', 0), promptFor('circle', 1));
  });
});

describe('placing points and text', () => {
  it('a click with the Point tool adds a point there, selects it, and stays on the tool', () => {
    const { tool, store, created } = setup();
    tool.setTool('point');
    tool.click(px(250, 500)); // 0.25 degree east, 0.5 south
    const [f] = store.features;
    assert.equal(f!.kind, 'point');
    close(f!.coordinates[0]![0], -84.75);
    close(f!.coordinates[0]![1], 37.5);
    assert.equal(tool.selected, f!.id);
    assert.equal(tool.tool, 'point');
    assert.equal(created.length, 1);
    tool.click(px(300, 500));
    assert.equal(store.features.length, 2);
  });

  it('a click with the Text tool adds text with a starting word to replace', () => {
    const { tool, store } = setup();
    tool.setTool('text');
    tool.click(px(0, 0));
    assert.equal(store.features[0]!.kind, 'text');
    assert.equal(store.features[0]!.properties.label, 'Text');
  });
});

describe('drawing a line or a polygon', () => {
  it('collects points, follows the pointer, and finishes on Enter with the shape selected and the tool back on Select', () => {
    const { tool, store, created } = setup();
    tool.setTool('line');
    tool.click(px(0, 0));
    tool.click(px(100, 0));
    tool.move(px(100, 50));
    const preview = tool.preview()!;
    assert.equal(preview.kind, 'line');
    assert.equal(preview.coordinates.length, 3); // two fixed points and the pointer
    tool.finish();
    const [f] = store.features;
    assert.equal(f!.kind, 'line');
    assert.equal(f!.coordinates.length, 2); // the pointer's place is not a point
    assert.equal(tool.tool, 'select');
    assert.equal(tool.selected, f!.id);
    assert.equal(tool.draft, null);
    assert.equal(created[0]!.id, f!.id);
  });

  it('a double-click finishes without adding a point from the second click', () => {
    const { tool, store } = setup();
    tool.setTool('polygon');
    tool.click(px(0, 0));
    tool.click(px(100, 0));
    tool.click(px(100, 100));
    tool.click(px(101, 101)); // the second click of a double-click: within 4 px of the last point
    tool.dblclick(px(101, 101));
    assert.equal(store.features[0]!.kind, 'polygon');
    assert.equal(store.features[0]!.coordinates.length, 3);
  });

  it('refuses a line of one point and a polygon of two, with a notice, and keeps drawing', () => {
    const { tool, store } = setup();
    tool.setTool('line');
    tool.click(px(0, 0));
    tool.finish();
    assert.match(tool.notice!, /at least 2 points/);
    assert.equal(store.features.length, 0);
    assert.ok(tool.draft);
    tool.setTool('polygon');
    tool.click(px(0, 0));
    tool.click(px(50, 0));
    tool.finish();
    assert.match(tool.notice!, /at least 3 points/);
    assert.equal(store.features.length, 0);
    tool.click(px(50, 50));
    assert.equal(tool.notice, null);
  });

  it('shows a polygon as a line until it has three places', () => {
    const { tool } = setup();
    tool.setTool('polygon');
    tool.click(px(0, 0));
    assert.equal(tool.preview(), null); // one place and the pointer is on it
    tool.move(px(50, 0));
    assert.equal(tool.preview()!.kind, 'line');
    tool.click(px(50, 0));
    tool.move(px(50, 50));
    assert.equal(tool.preview()!.kind, 'polygon');
  });

  it('Backspace takes back the last point, then the shape, and Escape cancels the shape', () => {
    const { tool, store } = setup();
    tool.setTool('line');
    tool.click(px(0, 0));
    tool.click(px(100, 0));
    assert.equal(tool.backspace(), true);
    assert.equal(tool.draft!.points.length, 1);
    assert.equal(tool.backspace(), true);
    assert.equal(tool.draft, null);
    tool.click(px(0, 0));
    assert.equal(tool.cancel(), true);
    assert.equal(tool.draft, null);
    assert.equal(store.features.length, 0);
    assert.equal(tool.tool, 'line'); // the first Escape only cancels the shape
  });
});

describe('rectangles and circles', () => {
  it('a rectangle is made from two corners on the screen, and its corners are in order', () => {
    const { tool, store } = setup();
    tool.setTool('rectangle');
    tool.click(px(100, 100));
    tool.move(px(300, 250));
    assert.equal(tool.preview()!.coordinates.length, 4);
    tool.click(px(300, 250));
    const f = store.features[0]!;
    assert.equal(f.kind, 'rectangle');
    const corners = f.coordinates.map((c) => view.project(c));
    assert.deepEqual(corners.map((p) => [Math.round(p.x), Math.round(p.y)]), [[100, 100], [300, 100], [300, 250], [100, 250]]);
  });

  it('a rectangle with no width is refused', () => {
    const { tool, store } = setup();
    tool.setTool('rectangle');
    tool.click(px(100, 100));
    tool.click(px(100, 300));
    assert.match(tool.notice!, /second corner/);
    assert.equal(store.features.length, 0);
    assert.ok(tool.draft);
  });

  it('a circle has the centre clicked and the radius to the second click, measured on the ground', () => {
    const { tool, store } = setup();
    tool.setTool('circle');
    tool.click(px(500, 500));
    tool.click(px(600, 500)); // 100 px = 0.1 degree east
    const f = store.features[0]!;
    assert.equal(f.kind, 'circle');
    const expected = groundDistanceM([-84.5, 37.5], [-84.4, 37.5]);
    close(f.radiusM!, expected, 0.01);
    assert.ok(f.radiusM! > 8_000 && f.radiusM! < 9_000, `radius ${f.radiusM}`); // 0.1 degree of longitude at 37.5 N is about 8.8 km
    assert.deepEqual(f.coordinates, [[-84.5, 37.5]]);
  });

  it('a circle with no radius is refused', () => {
    const { tool, store } = setup();
    tool.setTool('circle');
    tool.click(px(500, 500));
    tool.click(px(500, 500));
    assert.match(tool.notice!, /away from the centre/);
    assert.equal(store.features.length, 0);
  });
});

describe('selecting', () => {
  const withPolygon = () => {
    const s = setup();
    s.store.add({ kind: 'polygon', coordinates: [view.unproject(px(100, 100)), view.unproject(px(300, 100)), view.unproject(px(300, 300)), view.unproject(px(100, 300))] });
    s.tool.setTool('select');
    return s;
  };

  it('a click selects what is under it and a click on nothing deselects', () => {
    const { tool, store } = withPolygon();
    tool.click(px(200, 200));
    assert.equal(tool.selected, store.features[0]!.id);
    tool.click(px(600, 600));
    assert.equal(tool.selected, null);
  });

  it('Escape deselects, and then does nothing so the page can use it', () => {
    const { tool } = withPolygon();
    tool.click(px(200, 200));
    assert.equal(tool.cancel(), true);
    assert.equal(tool.selected, null);
    assert.equal(tool.cancel(), false);
    tool.setTool(null);
    assert.equal(tool.cancel(), false);
  });

  it('Escape from a drawing tool goes back to Select', () => {
    const { tool } = setup();
    tool.setTool('circle');
    assert.equal(tool.cancel(), true);
    assert.equal(tool.tool, 'select');
  });

  it('Backspace and Delete remove the selected shape, which can be brought back with undo', () => {
    const { tool, store } = withPolygon();
    tool.click(px(200, 200));
    assert.equal(tool.backspace(), true);
    assert.equal(store.features.length, 0);
    assert.equal(tool.selected, null);
    store.undo();
    assert.equal(store.features.length, 1);
    assert.equal(tool.backspace(), false); // nothing selected: not used, so another handler may have it
  });

  it('forgets the selection when the shape is gone by undo', () => {
    const { tool, store } = setup();
    tool.setTool('point');
    tool.click(px(10, 10));
    assert.ok(tool.selected);
    store.undo();
    assert.equal(tool.selected, null);
  });
});

describe('dragging', () => {
  const withSelected = (kind: 'polygon' | 'circle' | 'rectangle' | 'line') => {
    const s = setup();
    const at = (x: number, y: number) => view.unproject(px(x, y));
    if (kind === 'polygon') s.store.add({ kind, coordinates: [at(100, 100), at(300, 100), at(300, 300), at(100, 300)] });
    if (kind === 'rectangle') s.store.add({ kind, coordinates: [at(100, 100), at(300, 100), at(300, 300), at(100, 300)] });
    if (kind === 'line') s.store.add({ kind, coordinates: [at(100, 100), at(300, 100)] });
    if (kind === 'circle') s.store.add({ kind, coordinates: [at(500, 500)], radiusM: 5_000 });
    s.tool.setTool('select');
    s.tool.select(s.store.features[0]!.id);
    return s;
  };
  const pixelsOf = (f: DrawFeature) => f.coordinates.map((c) => view.project(c)).map((p) => [Math.round(p.x), Math.round(p.y)]);

  it('a press on a vertex takes hold of it (so the map must not pan), and letting go moves it in one step', () => {
    const { tool, store } = withSelected('polygon');
    assert.equal(tool.press(px(302, 99)), true);
    tool.move(px(350, 60));
    assert.equal(tool.dragging, true);
    // while dragging, the stored feature is untouched and the displayed one has moved
    assert.deepEqual(pixelsOf(store.features[0]!)[1], [300, 100]);
    assert.deepEqual(pixelsOf(tool.features()[0]!)[1], [350, 60]);
    tool.release();
    assert.deepEqual(pixelsOf(store.features[0]!), [[100, 100], [350, 60], [300, 300], [100, 300]]);
    store.undo(); // one step
    assert.deepEqual(pixelsOf(store.features[0]!)[1], [300, 100]);
  });

  it('a press that hardly moves is a click and changes nothing', () => {
    const { tool, store } = withSelected('polygon');
    assert.equal(tool.press(px(300, 100)), true);
    tool.move(px(302, 101));
    tool.release();
    assert.equal(store.canUndo, true); // the polygon was added...
    store.undo();
    assert.equal(store.features.length, 0); // ...and only that: the nudge was not a step
  });

  it('a press on the inside of a shape moves the whole shape, and selects it', () => {
    const { tool, store } = withSelected('polygon');
    tool.select(null);
    assert.equal(tool.press(px(200, 200)), true);
    assert.equal(tool.selected, store.features[0]!.id);
    tool.move(px(250, 230));
    tool.release();
    assert.deepEqual(pixelsOf(store.features[0]!), [[150, 130], [350, 130], [350, 330], [150, 330]]);
  });

  it('a press on nothing does not take hold, so the map can pan', () => {
    const { tool } = withSelected('polygon');
    assert.equal(tool.press(px(700, 700)), false);
  });

  it('does not take hold with a drawing tool on', () => {
    const { tool } = withSelected('polygon');
    tool.setTool('line');
    assert.equal(tool.press(px(300, 100)), false);
  });

  it('a circle: its centre handle moves it, and its edge handle changes the radius', () => {
    const { tool, store } = withSelected('circle');
    const before = store.features[0]!.radiusM!;
    assert.equal(tool.press(px(500, 500)), true);
    tool.move(px(560, 520));
    tool.release();
    assert.deepEqual(pixelsOf(store.features[0]!)[0], [560, 520]);
    assert.equal(store.features[0]!.radiusM, before);

    const edge = tool.handles[1]!;
    const edgePx = view.project(edge.at);
    assert.equal(tool.press(edgePx), true);
    tool.move(px(edgePx.x + 100, edgePx.y));
    tool.release();
    const after = store.features[0]!.radiusM!;
    assert.ok(after > before * 1.5, `${after} vs ${before}`);
    assert.deepEqual(pixelsOf(store.features[0]!)[0], [560, 520]); // the centre stays
  });

  it('a rectangle corner moves with its opposite corner fixed and stays a rectangle', () => {
    const { tool, store } = withSelected('rectangle');
    assert.equal(tool.press(px(300, 300)), true);
    tool.move(px(400, 350));
    tool.release();
    assert.deepEqual(pixelsOf(store.features[0]!), [[100, 100], [400, 100], [400, 350], [100, 350]]);
  });

  it('Escape during a drag puts the shape back', () => {
    const { tool, store } = withSelected('polygon');
    tool.press(px(300, 100));
    tool.move(px(500, 500));
    assert.equal(tool.cancel(), true);
    tool.release();
    assert.deepEqual(pixelsOf(store.features[0]!)[1], [300, 100]);
    assert.deepEqual(pixelsOf(tool.features()[0]!)[1], [300, 100]);
  });

  it('the click the browser sends after a drag does not deselect', () => {
    const { tool, store } = withSelected('polygon');
    tool.press(px(300, 100));
    tool.move(px(420, 100));
    tool.release();
    tool.click(px(420, 100)); // over the moved vertex, so it would stay selected anyway...
    tool.press(px(200, 200));
    tool.move(px(210, 210));
    tool.release();
    tool.click(px(900, 900)); // ...but a click on nothing straight after a drag is the drag's, and is ignored
    assert.equal(tool.selected, store.features[0]!.id);
    tool.click(px(900, 900)); // the next one is a real click
    assert.equal(tool.selected, null);
  });
});

describe('editing points of a line or polygon', () => {
  const at = (x: number, y: number) => view.unproject(px(x, y));
  it('a double-click on an edge adds a point there', () => {
    const s = setup();
    s.store.add({ kind: 'line', coordinates: [at(100, 100), at(300, 100)] });
    s.tool.setTool('select');
    s.tool.select(s.store.features[0]!.id);
    s.tool.dblclick(px(200, 103));
    const coords = s.store.features[0]!.coordinates.map((c) => view.project(c));
    assert.equal(coords.length, 3);
    close(coords[1]!.x, 200, 1e-6);
    close(coords[1]!.y, 100, 1e-6); // on the line, not where the pointer was
  });

  it('a double-click on a vertex removes it, but not below the least a shape can have', () => {
    const s = setup();
    s.store.add({ kind: 'polygon', coordinates: [at(100, 100), at(300, 100), at(300, 300), at(100, 300)] });
    s.tool.setTool('select');
    s.tool.select(s.store.features[0]!.id);
    s.tool.dblclick(px(300, 300));
    assert.equal(s.store.features[0]!.coordinates.length, 3);
    s.tool.dblclick(px(300, 100));
    assert.equal(s.store.features[0]!.coordinates.length, 3);
    assert.match(s.tool.notice!, /at least 3 points/);
  });

  it('does not add or remove points of a rectangle', () => {
    const s = setup();
    s.store.add({ kind: 'rectangle', coordinates: [at(100, 100), at(300, 100), at(300, 300), at(100, 300)] });
    s.tool.setTool('select');
    s.tool.select(s.store.features[0]!.id);
    s.tool.dblclick(px(200, 100));
    s.tool.dblclick(px(300, 300));
    assert.equal(s.store.features[0]!.coordinates.length, 4);
  });
});
