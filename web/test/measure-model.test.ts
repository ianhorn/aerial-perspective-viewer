import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gridToLonLat, lonLatToGrid } from '../src/lcc.ts';
import { MeasureModel, sides, type Vertex } from '../src/measure-model.ts';
import { overlayOf } from '../src/measure-shape.ts';

const v = (x: number, y: number, z = 500, extra: Partial<Vertex> = {}): Vertex => ({ x, y, z, frame: 'a.tif', ...extra });
const rows = (m: MeasureModel): Record<string, string> => Object.fromEntries(m.reading()!.rows.map((r) => [r.label, r.value]));
const at = (m: MeasureModel, tool: Parameters<MeasureModel['setTool']>[0], ...points: Vertex[]): MeasureModel => {
  m.setTool(tool);
  for (const p of points) m.addVertex(p, () => 500);
  return m;
};

describe('the tools', () => {
  it('starts with none on, turns one on and off, and clears what was measured when it changes', () => {
    const m = new MeasureModel();
    assert.equal(m.active, false);
    assert.equal(m.reading(), null);
    m.setTool('distance');
    assert.equal(m.active, true);
    m.addVertex(v(0, 0));
    m.setTool('area');
    assert.equal(m.vertices.length, 0);
    m.setTool('area'); // choosing the tool that is on turns it off
    assert.equal(m.tool, null);
    m.addVertex(v(0, 0)); // nothing is picked with no tool on
    assert.equal(m.vertices.length, 0);
  });

  it('tells the subscribers of every change', () => {
    const m = new MeasureModel();
    let n = 0;
    const off = m.subscribe(() => n++);
    m.setTool('distance');
    m.addVertex(v(0, 0));
    m.undo();
    m.addVertex(v(1, 1));
    m.clear();
    assert.equal(n, 5);
    off();
    m.setTool(null);
    assert.equal(n, 5);
  });
});

describe('a click that could not be placed', () => {
  it('shows why until the next click that works, and never changes the points', () => {
    const m = at(new MeasureModel(), 'distance', v(0, 0));
    m.setNotice('That is above the horizon.');
    assert.deepEqual(m.reading()!.warnings, ['That is above the horizon.']);
    assert.equal(m.vertices.length, 1);
    m.addVertex(v(3, 4));
    assert.deepEqual(m.reading()!.warnings, []);
    m.setNotice('again');
    m.clear();
    assert.equal(m.notice, null);
  });
});

describe('distance tools', () => {
  it('reads the level distance and the slope distance, and how the ground rises', () => {
    const level = rows(at(new MeasureModel(), 'distance', v(0, 0, 500), v(30, 40, 530)));
    assert.equal(level['Distance'], '50.0 ft (15.2 m)');
    assert.equal(level['Along the slope'], '58.3 ft (17.8 m)');
    assert.match(level['Elevation change']!, /^\+30\.0 ft/);
    assert.equal(level['Slope'], '60.0%');
    const slope = rows(at(new MeasureModel(), 'distance3d', v(0, 0, 500), v(30, 40, 530)));
    assert.equal(slope['Distance 3D'], '58.3 ft (17.8 m)');
    assert.equal(slope['Level distance'], '50.0 ft (15.2 m)');
  });

  it('adds points to a path, and says what to click next', () => {
    const m = at(new MeasureModel(), 'distance', v(0, 0));
    assert.equal(m.reading()!.prompt, 'Click the next point.');
    assert.deepEqual(m.reading()!.rows, []);
    m.addVertex(v(0, 100));
    m.addVertex(v(100, 100));
    assert.equal(rows(m)['Distance'], '200.0 ft (61.0 m)');
    m.undo();
    assert.equal(rows(m)['Distance'], '100.0 ft (30.5 m)');
  });
});

describe('area tools', () => {
  const square = [v(0, 0), v(100, 0), v(100, 100), v(0, 100)];

  it('needs three corners, then reads the area and the perimeter', () => {
    const m = at(new MeasureModel(), 'area', v(0, 0), v(100, 0));
    assert.equal(m.reading()!.prompt, 'Click a third corner to make an area.');
    m.addVertex(v(100, 100));
    m.addVertex(v(0, 100));
    assert.equal(rows(m)['Area'], '10,000 ft² (0.230 acres · 929.0 m²)');
    assert.equal(rows(m)['Perimeter'], '400.0 ft (121.9 m)');
  });

  it('reads the surface of the ground for the 3D area', () => {
    const m = new MeasureModel();
    m.setTool('area3d');
    for (const p of square) m.addVertex(p, (x) => 0.5 * x); // a 50% slope: 1.118 times the flat area
    assert.equal(rows(m)['Flat area'], '10,000 ft² (0.230 acres · 929.0 m²)');
    assert.match(rows(m)['Surface area']!, /^11,180 ft²/);
    assert.equal(rows(m)['Steeper by'], '11.8%');
  });

  it('warns when the outline crosses itself', () => {
    const m = at(new MeasureModel(), 'area', v(0, 0), v(100, 100), v(100, 0), v(0, 100));
    assert.ok(m.reading()!.warnings.some((w) => /crosses itself/.test(w)));
    assert.equal(at(new MeasureModel(), 'area', ...square).reading()!.warnings.length, 0);
  });
});

describe('location and height tools', () => {
  it('reads a surface location as latitude, longitude, elevation and grid position, and replaces it on the next click', () => {
    const [x, y] = lonLatToGrid(-85.7878, 38.2288);
    const m = at(new MeasureModel(), 'surface', v(x, y, 512.34));
    assert.equal(rows(m)['Latitude, longitude'], '38.228800, -85.787800');
    assert.equal(rows(m)['Ground elevation'], '512.3 ft (156.2 m)');
    m.addVertex(v(x + 100, y));
    assert.equal(m.vertices.length, 1);
  });

  it('reads a height once the top is picked, and starts again on the next click', () => {
    const m = at(new MeasureModel(), 'height', v(1000, 2000, 500));
    assert.equal(m.needsTop, true);
    assert.match(m.reading()!.prompt, /click the top/i);
    assert.deepEqual(m.reading()!.rows, []);
    m.setRise(42.3, 1);
    assert.equal(m.needsTop, false);
    assert.equal(rows(m)['Height'], '42.3 ft (12.9 m)');
    assert.equal(rows(m)['Top elevation'], '542.3 ft (165.3 m)');
    assert.equal(m.top!.z, 542.3);
    m.addVertex(v(1500, 2500, 480)); // the next click is a new base
    assert.equal(m.needsTop, true);
    assert.equal(m.rise, null);
    assert.equal(m.vertices.length, 1);
  });

  it('gives Location 3D as the top point, at the base point\'s place and above its ground', () => {
    const [x, y] = lonLatToGrid(-85.7878, 38.2288);
    const m = at(new MeasureModel(), 'location3d', v(x, y, 500));
    m.setRise(80, 2);
    assert.equal(rows(m)['Latitude, longitude'], '38.228800, -85.787800');
    assert.equal(rows(m)['Elevation'], '580.0 ft (176.8 m)');
    assert.equal(rows(m)['Height above ground'], '80.0 ft (24.4 m)');
    const [lon, lat] = gridToLonLat(m.top!.x, m.top!.y);
    assert.ok(Math.abs(lon + 85.7878) < 1e-6 && Math.abs(lat - 38.2288) < 1e-6);
  });

  it('warns about a top far from the line above the base, and about a top below the ground', () => {
    const off = at(new MeasureModel(), 'height', v(0, 0));
    off.setRise(10, 40);
    assert.ok(off.reading()!.warnings.some((w) => /40 px to the side/.test(w)));
    const under = at(new MeasureModel(), 'height', v(0, 0));
    under.setRise(-10, 0);
    assert.ok(under.reading()!.warnings.some((w) => /below the ground/.test(w)));
  });

  it('a setRise with no base picked is ignored', () => {
    const m = new MeasureModel();
    m.setTool('height');
    m.setRise(5, 0);
    assert.equal(m.rise, null);
  });

  it('warns when a photo had no elevation patch', () => {
    const m = at(new MeasureModel(), 'surface', v(0, 0, 500, { approximate: true }));
    assert.ok(m.reading()!.warnings.some((w) => /no elevation patch/.test(w)));
  });
});

describe('the drawing', () => {
  const project = (g: { x: number; y: number; z: number }): { x: number; y: number } => ({ x: g.x, y: -g.y });

  it('draws a path with a label on each side, and marks where it began', () => {
    const o = overlayOf(at(new MeasureModel(), 'distance', v(0, 0), v(30, 40), v(30, 140)), project);
    assert.deepEqual(o.dots.map((d) => d.kind), ['first', 'vertex', 'vertex']);
    assert.equal(o.lines.length, 1);
    assert.equal(o.lines[0]!.points.length, 3);
    assert.deepEqual(o.labels.map((l) => l.text), ['50.0 ft', '100.0 ft']);
    assert.equal(o.fill, null);
  });

  it('labels the sides of a 3D distance along the slope', () => {
    const o = overlayOf(at(new MeasureModel(), 'distance3d', v(0, 0, 500), v(30, 40, 530)), project);
    assert.deepEqual(o.labels.map((l) => l.text), ['58.3 ft']);
  });

  it('closes an area, tints it and labels its area once there are three corners', () => {
    const two = overlayOf(at(new MeasureModel(), 'area', v(0, 0), v(100, 0)), project);
    assert.equal(two.fill, null);
    assert.equal(two.lines[0]!.points.length, 2);
    const o = overlayOf(at(new MeasureModel(), 'area', v(0, 0), v(100, 0), v(100, 100), v(0, 100)), project);
    assert.equal(o.fill!.length, 4);
    assert.equal(o.lines[0]!.points.length, 5, 'the outline comes back to its start');
    assert.deepEqual(o.labels.map((l) => l.text), ['100.0 ft', '100.0 ft', '100.0 ft', '100.0 ft', '10,000 ft²']);
  });

  it('draws a height as a line from the base to the top, labelled, and Location 3D dashed with no label', () => {
    const h = at(new MeasureModel(), 'height', v(10, 10, 500));
    assert.equal(overlayOf(h, project).lines.length, 0, 'no line before the top is picked');
    h.setRise(40, 0);
    const o = overlayOf(h, project);
    assert.deepEqual(o.dots.map((d) => d.kind), ['first', 'top']);
    assert.deepEqual(o.labels.map((l) => l.text), ['40.0 ft']);
    const l3 = at(new MeasureModel(), 'location3d', v(10, 10, 500));
    l3.setRise(40, 0);
    const p = overlayOf(l3, project);
    assert.equal(p.lines[0]!.dashed, true);
    assert.deepEqual(p.labels, []);
  });

  it('leaves out points with no place in the drawing', () => {
    const behind = (g: { x: number; y: number; z: number }): { x: number; y: number } | null => (g.x < 0 ? null : { x: g.x, y: g.y });
    const o = overlayOf(at(new MeasureModel(), 'distance', v(-5, 0), v(30, 40), v(30, 140)), behind);
    assert.equal(o.dots.length, 2);
    assert.deepEqual(o.labels.map((l) => l.text), ['100.0 ft']);
    assert.deepEqual(overlayOf(new MeasureModel(), project), { dots: [], lines: [], fill: null, labels: [] });
  });

  it('sides() gives the closing side of a polygon only when asked', () => {
    const pts = [v(0, 0), v(10, 0), v(10, 10)];
    assert.equal(sides(pts, '2d').length, 2);
    assert.equal(sides(pts, '2d', true).length, 3);
  });
});
