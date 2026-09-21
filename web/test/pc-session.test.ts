import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LonLat } from '../src/pc-aoi.ts';
import type { Chunk } from '../src/pc-decode.ts';
import { PcSession, budgetFor, type Sink } from '../src/pc-session.ts';
import { fakeNetwork, gridRect, inProcessPool, lattice, X0, Y0 } from './support/pc-fake.ts';

function setup(opts: { network?: ReturnType<typeof fakeNetwork>; maxTotalPoints?: number; budget?: { maxPoints: number; maxBytes: number } } = {}) {
  const network = opts.network ?? fakeNetwork();
  const chunks: Chunk[] = [];
  const areas: { done: LonLat[][]; active: LonLat[] | null }[] = [];
  let cleared = 0;
  const sink: Sink = { add: (c) => chunks.push(c), clear: () => { cleared++; chunks.length = 0; }, setAreas: (done, active) => areas.push({ done: [...done], active }) };
  const session = new PcSession({ fetchFn: network.fetchFn, makePool: () => inProcessPool(network.fetchFn), sink, maxTotalPoints: opts.maxTotalPoints, budget: opts.budget });
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
    assert.ok(session.report.notes.some((n) => /more detail than fits in the limit/.test(n)));
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
    assert.deepEqual(session.report, { state: 'idle', progress: null, points: 0, summaries: [], notes: [], error: null });
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
