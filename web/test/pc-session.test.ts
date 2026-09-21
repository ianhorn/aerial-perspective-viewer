import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LonLat } from '../src/pc-aoi.ts';
import type { Chunk } from '../src/pc-decode.ts';
import { PcSession, budgetFor, chunkId, type Sink } from '../src/pc-session.ts';
import { fakeNetwork, gridRect, inProcessPool, lattice, NO_WAIT, X0, Y0 } from './support/pc-fake.ts';

function setup(opts: { network?: ReturnType<typeof fakeNetwork>; maxTotalPoints?: number; minRoom?: number; budget?: { maxPoints: number; maxBytes: number } } = {}) {
  const network = opts.network ?? fakeNetwork();
  const chunks: Chunk[] = [];
  const areas: { done: LonLat[][]; active: LonLat[] | null }[] = [];
  let cleared = 0;
  const sink: Sink = { add: (c) => chunks.push(c), remove: (ids) => { for (const id of ids) { const i = chunks.findIndex((c) => chunkId(c) === id); if (i >= 0) chunks.splice(i, 1); } }, clear: () => { cleared++; chunks.length = 0; }, setAreas: (done, active) => areas.push({ done: [...done], active }) };
  const session = new PcSession({ fetchFn: network.fetchFn, makePool: () => inProcessPool(network.fetchFn), sink, maxTotalPoints: opts.maxTotalPoints, minRoom: opts.minRoom, budget: opts.budget, retry: NO_WAIT, refineBudget: { maxPoints: 1e9, maxBytes: 1e12 } });
  return { session, chunks, areas, network, cleared: () => cleared };
}
const TILE = gridRect(X0 + 1, Y0 + 1, X0 + 4999, Y0 + 4999);

describe('the point cloud session', () => {
  it('loads an area: chunks go to the map, the report counts them, and the state goes loading then idle', async () => {
    const { session, chunks } = setup();
    const states: string[] = [];
    session.subscribe(() => states.push(session.report.state));
    await session.load(TILE);
    assert.equal(chunks.length, 21);
    assert.equal(session.report.points, 10000);
    assert.equal(session.report.state, 'idle');
    assert.equal(session.report.summaries.length, 1);
    assert.equal(session.report.error, null);
    assert.equal(states[0], 'loading');
    assert.equal(states.at(-1), 'idle');
  });

  it('sets the colour range from the middle 96% of the heights loaded', async () => {
    const { session } = setup();
    await session.load(TILE);
    const z = lattice().map((p) => p.z).sort((a, b) => a - b);
    const [lo, hi] = session.range!;
    assert.ok(Math.abs(lo - z[Math.floor(0.02 * z.length)]!) < 1.5, `${lo}`);
    assert.ok(Math.abs(hi - z[Math.floor(0.98 * z.length)]!) < 1.5, `${hi}`);
  });

  it('sets the colours from the first (coarse) block, so the map is coloured while the rest is still coming', async () => {
    const { session } = setup({ network: fakeNetwork({ slow: 5 }) });
    const rangeWhileLoading: ([number, number] | null)[] = [];
    session.subscribe(() => { if (session.loading && session.report.progress && session.report.progress.loadedNodes >= 1) rangeWhileLoading.push(session.range); });
    await session.load(TILE);
    assert.ok(rangeWhileLoading.length > 0);
    assert.ok(rangeWhileLoading.every((r) => r !== null));
  });

  it('shows the area while it loads and keeps its outline after', async () => {
    const { session, areas } = setup();
    await session.load(TILE);
    assert.ok(areas.some((a) => a.active !== null && a.done.length === 0));
    assert.equal(areas.at(-1)!.active, null);
    assert.equal(areas.at(-1)!.done.length, 1);
  });

  it('shrinks an area that is over the limit to its middle, and says so', async () => {
    const { session } = setup();
    await session.load(gridRect(X0 + 2500 - 10000, Y0 + 2500 - 10000, X0 + 2500 + 10000, Y0 + 2500 + 10000)); // 14 square miles over the tile
    assert.ok(session.report.notes.some((n) => /bigger than the 4 square miles/.test(n)));
    assert.ok(session.report.points > 0);
  });

  it('says so when nothing covers the area', async () => {
    const { session } = setup();
    await session.load(gridRect(X0 + 900_000, Y0, X0 + 901_000, Y0 + 1000));
    assert.equal(session.report.points, 0);
    assert.ok(session.report.notes.some((n) => /No KyFromAbove point cloud covers that area/.test(n)));
  });

  it('says so when the budget meant a coarser picture than the file has, and reads what fits', async () => {
    const { session } = setup({ budget: { maxPoints: 1000, maxBytes: 1e12 } });
    await session.load(TILE);
    assert.equal(session.report.points, 625);
    assert.ok(session.report.notes.some((n) => /more detail than fits at once, so it is shown coarser/.test(n)));
    const full = setup();
    await full.session.load(TILE);
    assert.ok(!full.session.report.notes.some((n) => /more detail than fits/.test(n)));
  });

  it('loads add up, up to the most the map may hold, and then it asks for a clear', async () => {
    const { session } = setup({ maxTotalPoints: 100_000 });
    for (let i = 0; i < 6; i++) await session.load(TILE); // 60,000 points; 40,000 of room is under the 50,000 minimum
    assert.equal(session.report.points, 60000);
    assert.equal(session.report.summaries.length, 6);
    await session.load(TILE);
    assert.match(session.report.error!, /Clear the point cloud/);
    assert.equal(session.report.points, 60000);
    session.clear();
    await session.load(TILE);
    assert.equal(session.report.error, null);
    assert.equal(session.report.points, 10000);
  });

  it('the budget for a load is the room left, up to the usual budget', () => {
    assert.equal(budgetFor(1_000_000).maxPoints, 1_000_000);
    assert.equal(budgetFor(50_000_000).maxPoints, 4_000_000);
  });

  it('clearing takes everything off and forgets the range', async () => {
    const { session, chunks, cleared, areas } = setup();
    await session.load(TILE);
    session.clear();
    assert.equal(chunks.length, 0);
    assert.equal(cleared(), 1);
    assert.deepEqual(session.report, { state: 'idle', progress: null, points: 0, summaries: [], notes: [], error: null, refining: false, detailProblem: null });
    assert.equal(session.range, null);
    assert.deepEqual(areas.at(-1), { done: [], active: null });
  });

  it('stopping keeps what has arrived, and is not an error', async () => {
    const { session, chunks } = setup({ network: fakeNetwork({ slow: 10 }) });
    session.subscribe(() => { if (session.report.progress && session.report.progress.loadedNodes >= 3) session.cancel(); });
    await session.load(TILE);
    assert.equal(session.report.state, 'idle');
    assert.equal(session.report.error, null);
    assert.ok(session.report.notes.some((n) => /Stopped/.test(n)));
    assert.ok(chunks.length >= 3 && chunks.length < 21);
    assert.equal(session.report.points, chunks.reduce((s, c) => s + c.count, 0));
  });

  it('a newer load takes over from an older one: the older one adds nothing more and is not reported', async () => {
    const network = fakeNetwork({ slow: 20 });
    const { session, chunks } = setup({ network });
    const first = session.load(TILE);
    await new Promise((r) => setTimeout(r, 120));
    const before = chunks.length;
    const second = session.load(gridRect(X0 + 100, Y0 + 100, X0 + 600, Y0 + 600));
    await first; // the older load ends as soon as it is cancelled...
    assert.equal(session.report.state, 'loading'); // ...and does not report itself over the newer one, which is still going
    assert.ok(!session.report.notes.some((n) => /Stopped/.test(n)));
    await second;
    assert.equal(session.report.summaries.length, 1); // only the second finished
    assert.equal(session.report.state, 'idle');
    assert.equal(session.report.points, chunks.reduce((s, c) => s + c.count, 0));
    assert.ok(chunks.length - before <= 3 + 2, `${chunks.length - before} chunks after the switch`); // the second load's three nodes, and at most a couple of the first's already in flight
  });

  it('turns a failure into a message and leaves the map as it was', async () => {
    const { session, chunks } = setup({ network: fakeNetwork({ missing: true }) });
    await session.load(TILE);
    assert.match(session.report.error!, /None of the point-cloud files could be read/);
    assert.equal(session.report.state, 'idle');
    assert.equal(chunks.length, 0);
  });
});

describe('adding detail for the screen', () => {
  // The screen is a grid rectangle at some feet a pixel, north up: what `pc-lod` needs of a map. The tiny file's points are 200 ft apart at the top level,
  // so a node is wanted when it is more than 37.5 pixels across (2 x size x 200 / 5,000 > 3).
  const screen = (x: number, y: number, ftPerPx: number, width: number, height: number) => ({ width, height, project: (gx: number, gy: number) => ({ x: (gx - x) / ftPerPx, y: height - (gy - y) / ftPerPx }) });
  const lowerLeft = screen(X0, Y0, 20, 50, 50); // 1,000 ft each way from the tile's corner
  const upperRight = screen(X0 + 4000, Y0 + 4000, 20, 50, 50);
  const COARSE = { maxPoints: 1000, maxBytes: 1e12 }; // reads the top level only (625 points) at first
  const keys = (chunks: Chunk[]) => chunks.map((c) => c.key).sort();
  /** How many of the made-up file's points are in a node, at its own level (make_copc.py: level 0 every 4th point, level 1 every 2nd of the rest, level 2 the rest). */
  const inNode = (level: number, depth: number, ix: number, iy: number): number => {
    const size = 5000 / 2 ** depth;
    return lattice().filter((p) => p.level === level && Math.floor((p.x - X0) / size) === ix && Math.floor((p.y - Y0) / size) === iy).length;
  };
  const start = async (opts: Parameters<typeof setup>[0] = {}) => {
    const s = setup({ budget: COARSE, ...opts });
    await s.session.load(TILE);
    return s;
  };

  it('adds the levels that are wanted where the screen is, and only there', async () => {
    const { session, chunks } = await start();
    assert.deepEqual(keys(chunks), ['0-0-0-0']);
    assert.equal(session.report.points, 625);
    await session.refine(lowerLeft);
    // over the lower left 1,000 ft: level 1's node over it (2,500 ft) and level 2's (1,250 ft, whose margin reaches 1,150 ft: the next one starts at 1,250)
    assert.deepEqual(keys(chunks), ['0-0-0-0', '1-0-0-0', '2-0-0-0']);
    assert.equal(session.report.points, 625 + inNode(1, 1, 0, 0) + inNode(2, 2, 0, 0));
    assert.equal(session.report.refining, false);
  });

  it('adds nothing new when the screen has not changed, and does not ask for anything again', async () => {
    const { session, chunks, network } = await start();
    await session.refine(lowerLeft);
    const [n, requests, points] = [chunks.length, network.log.ranges.length, session.report.points];
    await session.refine(lowerLeft);
    assert.equal(chunks.length, n);
    assert.equal(network.log.ranges.length, requests);
    assert.equal(session.report.points, points);
  });

  it('adds more where the screen moves to, keeping what is there', async () => {
    const { session, chunks } = await start();
    await session.refine(lowerLeft);
    await session.refine(upperRight);
    assert.deepEqual(keys(chunks), ['0-0-0-0', '1-0-0-0', '1-1-1-0', '2-0-0-0', '2-3-3-0']);
    assert.equal(session.report.points, 625 + inNode(1, 1, 0, 0) + inNode(2, 2, 0, 0) + inNode(1, 1, 1, 1) + inNode(2, 2, 3, 3));
  });

  it('zoomed out, nothing more is wanted (the top level is fine enough)', async () => {
    const { session, chunks } = await start();
    await session.refine(screen(X0, Y0, 25, 200, 200)); // the whole tile in 200 px: level 0 is 200 px, level 1 100 px: the top level's points are 8 px apart, so level 1 IS wanted...
    assert.ok(chunks.length > 1);
    const n = chunks.length;
    await session.refine(screen(X0, Y0, 200, 25, 25)); // ...but the whole tile in 25 px is under the 37.5 px that level 0 needs: nothing
    assert.equal(chunks.length, n);
  });

  it('does not ask again for a node that had no points inside the area', async () => {
    const { session, network, chunks } = setup({ budget: { maxPoints: 1e9, maxBytes: 1 } }); // the load reads the top node only, however small the area
    // 50 ft square holding one of the file's points (at 125, 125 ft, a level 1 point): the top level and the level 2 node over it have none in it
    await session.load(gridRect(X0 + 110, Y0 + 110, X0 + 160, Y0 + 160));
    await session.refine(lowerLeft);
    assert.deepEqual(keys(chunks), ['1-0-0-0']); // the top node had none of the area's point (it is not among the blocks), and only the level 1 node has it
    const requests = network.log.ranges.length;
    await session.refine(lowerLeft);
    assert.equal(network.log.ranges.length, requests); // the empty nodes (0-0-0-0 and 2-0-0-0) are not asked for again
  });

  it('stays inside the limit by taking off what is off the screen, and reads it again if the screen comes back', async () => {
    const { session, chunks } = await start({ maxTotalPoints: 1500, minRoom: 0 });
    await session.refine(lowerLeft);
    // 625 + 456 fits; the level 2 node (456 more) would not, and the top level is on the screen: it is left out
    assert.deepEqual(keys(chunks), ['0-0-0-0', '1-0-0-0']);
    await session.refine(upperRight);
    // now the lower left is off the screen: its node is taken off to make room for the upper right's; the second would not fit
    assert.deepEqual(keys(chunks), ['0-0-0-0', '1-1-1-0']);
    assert.ok(session.report.points <= 1500);
    assert.equal(session.report.points, chunks.reduce((s, c) => s + c.count, 0));
    await session.refine(lowerLeft);
    assert.deepEqual(keys(chunks), ['0-0-0-0', '1-0-0-0']); // read again
  });

  it('a screen asked for during a load waits, and one asked for during a pass is done after it', async () => {
    const { session, chunks } = setup({ budget: COARSE, network: fakeNetwork({ slow: 10 }) });
    const loading = session.load(TILE);
    await new Promise((r) => setTimeout(r, 15));
    const early = session.refine(lowerLeft); // during the load
    await loading;
    await early;
    await new Promise((r) => setTimeout(r, 400)); // the deferred pass runs once the load is over
    assert.ok(keys(chunks).includes('1-0-0-0'));
    const first = session.refine(lowerLeft);
    const second = session.refine(upperRight); // during the pass
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(keys(chunks).includes('1-1-1-0'));
  });

  it('does nothing before anything is loaded, and stops when the map is cleared', async () => {
    const { session, chunks, network } = setup({ budget: COARSE, network: fakeNetwork({ slow: 20 }) });
    await session.refine(lowerLeft);
    assert.equal(chunks.length, 0);
    assert.equal(network.log.ranges.length, 0);
    await session.load(TILE);
    const pass = session.refine(lowerLeft);
    await new Promise((r) => setTimeout(r, 30));
    session.clear();
    await pass;
    assert.equal(chunks.length, 0);
    assert.equal(session.report.points, 0);
    assert.equal(session.report.refining, false);
    await session.load(TILE); // and a new load works after that
    assert.equal(session.report.points, 625);
  });

  it('keeps its workers for later passes, stops them when cleared, and starts new ones for the next load', async () => {
    const network = fakeNetwork();
    const pools: { closed: number }[] = [];
    const chunks: Chunk[] = [];
    const sink: Sink = { add: (c) => chunks.push(c), remove: () => undefined, clear: () => { chunks.length = 0; }, setAreas: () => undefined };
    const session = new PcSession({
      fetchFn: network.fetchFn, sink, budget: COARSE,
      makePool: () => { const pool = inProcessPool(network.fetchFn); const record = { closed: 0 }; const close = pool.close.bind(pool); pool.close = () => { record.closed++; close(); }; pools.push(record); return pool; },
    });
    await session.load(TILE);
    await session.load(TILE);
    assert.equal(pools.length, 1); // both loads, and the passes after them, use the same workers
    await session.refine(lowerLeft);
    assert.equal(pools[0]!.closed, 0);
    session.clear();
    assert.equal(pools[0]!.closed, 1);
    await session.load(TILE);
    assert.equal(pools.length, 2);
  });

  it('a block that cannot be fetched is reported, and asked for again by the next pass', async () => {
    const network = fakeNetwork();
    const chunks: Chunk[] = [];
    const sink: Sink = { add: (c) => chunks.push(c), remove: () => undefined, clear: () => undefined, setAreas: () => undefined };
    let broken = true;
    const asked: string[] = [];
    const session = new PcSession({
      fetchFn: network.fetchFn, sink, budget: COARSE, retry: NO_WAIT,
      makePool: () => {
        const pool = inProcessPool(network.fetchFn);
        const decode = pool.decode.bind(pool);
        pool.decode = (m) => { asked.push(m.key); return broken && m.key === '1-0-0-0' ? Promise.reject(new Error('Failed to fetch')) : decode(m); };
        return pool;
      },
    });
    await session.load(TILE);
    await session.refine(lowerLeft);
    assert.match(session.report.detailProblem!, /1 block of finer detail could not be fetched/);
    assert.ok(!chunks.some((c) => c.key === '1-0-0-0'));
    assert.ok(chunks.some((c) => c.key === '2-0-0-0')); // the rest of the pass went on
    broken = false;
    await session.refine(lowerLeft);
    assert.equal(session.report.detailProblem, null);
    assert.ok(chunks.some((c) => c.key === '1-0-0-0')); // and it was asked for again, and arrived
    assert.equal(asked.filter((k) => k === '1-0-0-0').length, 2);
  });

  it('a load with a block that cannot be fetched says so in a note, and shows the rest', async () => {
    const network = fakeNetwork();
    const chunks: Chunk[] = [];
    const sink: Sink = { add: (c) => chunks.push(c), remove: () => undefined, clear: () => undefined, setAreas: () => undefined };
    const session = new PcSession({
      fetchFn: network.fetchFn, sink, retry: NO_WAIT,
      makePool: () => { const pool = inProcessPool(network.fetchFn); const decode = pool.decode.bind(pool); pool.decode = (m) => (m.key === '2-1-1-0' ? Promise.reject(new Error('Failed to fetch')) : decode(m)); return pool; },
    });
    await session.load(TILE);
    assert.equal(session.report.error, null);
    assert.equal(chunks.length, 20);
    assert.ok(session.report.notes.some((n) => /1 block of points could not be fetched, so there is a gap/.test(n)));
  });

  it('the note about a gap goes when a later pass gets the block', async () => {
    const network = fakeNetwork();
    const chunks: Chunk[] = [];
    const sink: Sink = { add: (c) => chunks.push(c), remove: () => undefined, clear: () => undefined, setAreas: () => undefined };
    let broken = true;
    const session = new PcSession({
      fetchFn: network.fetchFn, sink, retry: NO_WAIT,
      makePool: () => { const pool = inProcessPool(network.fetchFn); const decode = pool.decode.bind(pool); pool.decode = (m) => (broken && m.key === '2-1-1-0' ? Promise.reject(new Error('Failed to fetch')) : decode(m)); return pool; },
    });
    await session.load(TILE);
    assert.equal(session.report.notes.filter((n) => /could not be fetched/.test(n)).length, 1);
    broken = false;
    await session.refine(screen(X0 + 1250, Y0 + 1250, 20, 50, 50)); // over the block that failed
    assert.ok(chunks.some((c) => c.key === '2-1-1-0'));
    assert.equal(session.report.notes.filter((n) => /could not be fetched/.test(n)).length, 0);
    assert.equal(session.report.points, 10000);
  });

  it('Stop ends a pass, and the blocks that arrived stay', async () => {
    const { session, chunks } = setup({ budget: COARSE, network: fakeNetwork({ slow: 15 }) });
    await session.load(TILE);
    const pass = session.refine(screen(X0, Y0, 20, 250, 250)); // the whole tile at a zoom that wants everything
    await new Promise((r) => setTimeout(r, 60));
    session.cancel();
    await pass;
    assert.ok(chunks.length >= 1 && chunks.length < 21);
    assert.equal(session.report.points, chunks.reduce((s, c) => s + c.count, 0));
  });
});
