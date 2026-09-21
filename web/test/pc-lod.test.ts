import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MARGIN, nodesForView, place, TARGET_SPACING_PX, wanted, type View } from '../src/pc-lod.ts';
import type { Box, NodeRef } from '../src/pc-plan.ts';

/** A screen that shows the grid rectangle [x, y] to [x + width * ftPerPx, y + height * ftPerPx], north up. */
const screen = (x: number, y: number, ftPerPx: number, width = 1000, height = 800): View => ({
  width, height,
  project: (gx, gy) => ({ x: (gx - x) / ftPerPx, y: height - (gy - y) / ftPerPx }),
});
/** A file of 5,000 ft with a spacing of 34 ft at the top level (the state's): a node's box, and the constant c = spacing / size = 0.0068. */
const CUBE = 5000, SPACING = 34;
function node(depth: number, ix: number, iy: number, over: Partial<NodeRef> = {}): NodeRef {
  const size = CUBE / 2 ** depth;
  return { file: 0, key: `${depth}-${ix}-${iy}-0`, depth, count: 1000, offset: 0, length: 5000, box: [ix * size, iy * size, (ix + 1) * size, (iy + 1) * size], spacingFt: SPACING / 2 ** depth, ...over };
}
const WHOLE: Box = [0, 0, CUBE, CUBE];
const none = () => false;
const keys = (nodes: NodeRef[]) => nodes.map((n) => n.key);

describe('what is wanted on the screen', () => {
  it('a node is wanted when the level above its points would be coarser than the target on the screen (worked out by hand)', () => {
    // the whole file (5,000 ft) across 400 px: 12.5 ft a pixel. Its points are 34 ft apart: 2.7 px. Its children's: 17 ft: 1.4 px.
    // Level 0's own points are 2.7 px apart, under 3, so level 0 is wanted only if the "level above" (68 ft apart, 5.4 px) is coarser than 3: it is.
    assert.equal(wanted(node(0, 0, 0), 400), true); // 2 x 400 x 0.0068 = 5.44 > 3
    // level 1 (2,500 ft across, 200 px): the level above is level 0, 2.7 px apart: not coarser than 3, so level 1 is not wanted
    assert.equal(wanted(node(1, 0, 0), 200), false); // 2 x 200 x 0.0068 = 2.72
    // zoom in twice (800 px): level 1 is 400 px: level 0's points are 5.4 px apart: level 1 is wanted
    assert.equal(wanted(node(1, 0, 0), 400), true);
    assert.equal(TARGET_SPACING_PX, 3);
  });

  it('a target of your own is used', () => {
    assert.equal(wanted(node(1, 0, 0), 200, 2), true); // 2.72 > 2
    assert.equal(wanted(node(1, 0, 0), 200, 4), false);
  });

  it('a node\'s size and place on the screen, and whether it is on it', () => {
    const view = screen(1000, 1000, 5); // 5 ft a pixel, 1000 x 800 px: shows 1,000 to 6,000 ft east and 1,000 to 5,000 ft north
    const p = place(node(2, 1, 1), view)!; // 1,250 to 2,500 ft each way: 250 px across
    assert.ok(Math.abs(p.side - 250) < 1e-9);
    assert.ok(Math.abs(p.centre.x - 175) < 1e-9); // (1,875 - 1,000) / 5
    assert.ok(Math.abs(p.centre.y - (800 - (1875 - 1000) / 5)) < 1e-9); // north is up the screen
    assert.equal(p.onScreen, true);
    assert.equal(place(node(2, 3, 0), view)!.onScreen, true); // 3,750 to 5,000 east, 0 to 1,250 north: its top 50 px are on the screen
    assert.equal(place(node(4, 0, 0), view)!.onScreen, false); // 0 to 312 ft each way: 137 px off the left (inside the 150 px margin) but 137 px below the bottom (the margin is 120)
  });

  it('a node just off the screen counts as on it, within the margin, and not far beyond', () => {
    const view = screen(0, 0, 5, 1000, 800); // shows 0 to 5,000 east, 0 to 4,000 north
    const edge = node(4, 16, 0); // depth 4 is 312.5 ft: x from 5,000 to 5,312.5: 0 to 62 px off the right edge
    assert.equal(place(edge, view)!.onScreen, true); // inside the margin of 150 px
    assert.equal(place(node(4, 21, 0), view)!.onScreen, false); // 6,562 ft: 312 px off the edge
    assert.equal(MARGIN, 0.15);
  });

  it('a node beyond the horizon of a tilted map (no place on the screen) is not wanted', () => {
    const view: View = { width: 100, height: 100, project: (x) => ({ x: x > 2000 ? NaN : x, y: 0 }) };
    assert.equal(place(node(0, 0, 0), view), null);
  });
});

describe('nodes for the screen', () => {
  const nodes = [node(0, 0, 0), node(1, 0, 0), node(1, 1, 0), node(1, 0, 1), node(1, 1, 1), ...[0, 1].flatMap((x) => [0, 1].map((y) => node(2, x, y)))];

  it('zoomed out, only the top level; zoomed in, finer levels, and only where you look', () => {
    // 12.5 ft a pixel over the whole file: level 0 is 400 px and wanted (5.4 > 3); level 1 is 200 px and not (2.7)
    let got = nodesForView(nodes, screen(0, 0, 12.5, 400, 400), { skip: none, aoi: WHOLE });
    assert.deepEqual(keys(got), ['0-0-0-0']);
    // 1.5 ft a pixel: the screen shows the lower left 1,500 ft (and a margin of 225 ft). Level 0 and the level 1 node over it are wanted (1,667 px);
    // the other level 1 nodes start at 2,500 ft, off the screen; all four level 2 nodes (1,250 ft, 833 px) reach the screen: they start at 0 or 1,250 ft
    got = nodesForView(nodes, screen(0, 0, 1.5, 1000, 1000), { skip: none, aoi: WHOLE });
    assert.deepEqual(keys(got).sort(), ['0-0-0-0', '1-0-0-0', '2-0-0-0', '2-0-1-0', '2-1-0-0', '2-1-1-0']);
    // pan to the upper right of the file: the same zoom picks the nodes there instead
    got = nodesForView(nodes, screen(3500, 3500, 1.5, 1000, 1000), { skip: none, aoi: WHOLE });
    assert.deepEqual(keys(got).sort(), ['0-0-0-0', '1-1-1-0']); // level 2 is not in the list here: the list has level 2 only for the lower left
  });

  it('skips nodes that are already on the map', () => {
    const view = screen(0, 0, 1.5, 1000, 1000);
    const all = nodesForView(nodes, view, { skip: none, aoi: WHOLE });
    const loaded = new Set(['0-0-0-0', '1-0-0-0']);
    const rest = nodesForView(nodes, view, { skip: (n) => loaded.has(n.key), aoi: WHOLE });
    assert.deepEqual(keys(rest), keys(all).filter((k) => !loaded.has(k)));
    assert.deepEqual(nodesForView(nodes, view, { skip: () => true, aoi: WHOLE }), []);
  });

  it('coarse levels first, and within a level the nearest to the middle of the screen first', () => {
    const view = screen(0, 0, 2, 1600, 1600); // 3,200 ft each way, the middle of the screen at (1,600, 1,600) ft; level 1 nodes are 2,500 ft, wanted
    const got = nodesForView(nodes, view, { skip: none, aoi: WHOLE });
    const depths = got.map((n) => n.depth);
    assert.deepEqual(depths, [...depths].sort((a, b) => a - b));
    assert.deepEqual(keys(got).filter((k) => k.startsWith('1-')), ['1-0-0-0', '1-1-0-0', '1-0-1-0', '1-1-1-0'].filter((k) => keys(got).includes(k)));
    // the one whose middle is nearest the middle of the screen, (1,250, 1,250) ft against (3,750, 1,250), (1,250, 3,750) and (3,750, 3,750), is first
    assert.equal(keys(got).filter((k) => k.startsWith('1-'))[0], '1-0-0-0');
  });

  it('stops at the budget, coarse levels first, counting only the share of a node the area covers, and never returns nothing when something is wanted', () => {
    const view = screen(0, 0, 1.5, 1000, 1000);
    const wide = nodesForView(nodes, view, { skip: none, aoi: WHOLE });
    assert.ok(wide.length >= 4);
    const tight = nodesForView(nodes, view, { skip: none, aoi: WHOLE, budget: { maxPoints: 2500, maxBytes: 1e9 } }); // 1,000 points a node: two and a bit
    assert.equal(tight.length, 2);
    assert.deepEqual(keys(tight), keys(wide).slice(0, 2)); // the coarsest first
    const bytes = nodesForView(nodes, view, { skip: none, aoi: WHOLE, budget: { maxPoints: 1e9, maxBytes: 12000 } }); // 5,000 bytes a node
    assert.equal(bytes.length, 2);
    const one = nodesForView(nodes, view, { skip: none, aoi: WHOLE, budget: { maxPoints: 1, maxBytes: 1 } });
    assert.equal(one.length, 1); // even a node over the budget is read, if it is the first wanted (there would otherwise be nothing to show)
    // a node the area only half covers costs half its points
    const half: Box = [0, 0, CUBE / 2, CUBE];
    const cheap = nodesForView([node(0, 0, 0)], screen(0, 0, 12.5, 400, 400), { skip: none, aoi: half, budget: { maxPoints: 600, maxBytes: 1e9 } });
    assert.equal(cheap.length, 1);
  });

  it('works across files with their own spacing', () => {
    const fine = node(0, 0, 0, { file: 1, key: '0-0-0-0', spacingFt: 3.4 }); // ten times denser
    const view = screen(0, 0, 12.5, 400, 400);
    assert.deepEqual(nodesForView([fine], view, { skip: none, aoi: WHOLE }), []); // its points are 0.27 px apart at this zoom: level 0 is already finer than needed
    assert.equal(nodesForView([node(0, 0, 0)], view, { skip: none, aoi: WHOLE }).length, 1);
  });
});
