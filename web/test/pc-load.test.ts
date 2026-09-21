import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gridToLonLat } from '../src/lcc.ts';
import { insideGrid } from '../src/pc-aoi.ts';
import type { Chunk } from '../src/pc-decode.ts';
import { loadPointCloud, nodesOver, rangeGetter, RETRY, type Progress } from '../src/pc-load.ts';
import { lonLatToMercator, metreInMercator } from '../src/pc-warp.ts';
import { fakeNetwork, FIXTURE, gridRect, inProcessPool, lattice, NO_WAIT, X0, Y0 } from './support/pc-fake.ts';

const BIG = { maxPoints: 1e9, maxBytes: 1e12 };

async function run(area: [number, number][], opts: { budget?: { maxPoints: number; maxBytes: number }; network?: ReturnType<typeof fakeNetwork>; signal?: AbortSignal } = {}) {
  const network = opts.network ?? fakeNetwork();
  const pool = inProcessPool(network.fetchFn);
  const asked: string[] = [];
  const decode = pool.decode.bind(pool);
  pool.decode = (m) => { asked.push(m.key); return decode(m); };
  const chunks: Chunk[] = [];
  const progress: Progress[] = [];
  const summary = await loadPointCloud(area, { fetchFn: network.fetchFn, pool, loadId: 1, retry: NO_WAIT, budget: opts.budget ?? BIG, signal: opts.signal, onChunk: (c) => chunks.push(c), onProgress: (p) => progress.push(p) });
  pool.close();
  return { summary, chunks, progress, log: network.log, asked };
}

describe('loading a point cloud, end to end on the tiny file', () => {
  const everything = gridRect(X0 + 1, Y0 + 1, X0 + 4999, Y0 + 4999); // 1 square mile: the whole tile

  it('reads every point of the tile when the budget allows, and tells where they are and how high', async () => {
    const { summary, chunks } = await run(everything);
    assert.equal(summary.points, 10000);
    assert.equal(chunks.reduce((s, c) => s + c.count, 0), 10000);
    assert.deepEqual(summary.tiles, { phase3: 0, phase2: 1 });
    assert.equal(summary.depth, 2);
    assert.equal(summary.deepest, 2);
    assert.equal(chunks.length, 21);
    // every point's height is the generator's formula, at the position the map has it
    const truth = lattice();
    const heights = truth.map((p) => p.z).sort((a, b) => a - b);
    const got = chunks.flatMap((c) => Array.from({ length: c.count }, (_, i) => c.positions[i * 3 + 2]!)).sort((a, b) => a - b);
    assert.equal(got.length, heights.length);
    for (let i = 0; i < got.length; i += 97) assert.ok(Math.abs(got[i]! - heights[i]!) < 0.01, `${i}: ${got[i]} vs ${heights[i]}`);
    assert.ok(Math.min(...chunks.map((c) => c.zMin)) > 399 && Math.max(...chunks.map((c) => c.zMax)) < 476);
  });

  it('puts each point where the map has that ground, to a millimetre, and clips to the area', async () => {
    const area = gridRect(X0 + 1000, Y0 + 2000, X0 + 2000, Y0 + 3000); // 1,000 ft square
    const { summary, chunks } = await run(area);
    const inside = lattice().filter((p) => p.x >= X0 + 1000 && p.x <= X0 + 2000 && p.y >= Y0 + 2000 && p.y <= Y0 + 3000);
    assert.equal(summary.points, inside.length);
    assert.equal(inside.length, 400); // 20 x 20 points 50 ft apart
    // every point the map got is at the exact projection of one lattice point, and every lattice point inside the area was got
    const expected = inside.map((p) => {
      const [lon, lat] = gridToLonLat(p.x, p.y);
      return { p, m: lonLatToMercator(lon, lat), lat, used: false };
    });
    let worst = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.count; i++) {
        const mx = c.origin[0] + c.positions[i * 3]!, my = c.origin[1] + c.positions[i * 3 + 1]!;
        const near = expected.filter((e) => Math.hypot(mx - e.m[0], my - e.m[1]) / metreInMercator(e.lat) < 0.01); // within a centimetre
        assert.equal(near.length, 1, `a point at ${mx}, ${my} is not at exactly one lattice point`);
        const e = near[0]!;
        assert.equal(e.used, false);
        e.used = true;
        worst = Math.max(worst, Math.hypot(mx - e.m[0], my - e.m[1]) / metreInMercator(e.lat));
        assert.ok(Math.abs(c.positions[i * 3 + 2]! - e.p.z) < 0.01, 'the height');
      }
    }
    assert.ok(expected.every((e) => e.used), 'every lattice point inside the area is there');
    assert.ok(worst < 0.002, `worst position error ${worst} m`);
    // and none is outside the area: every point maps back inside the polygon
    for (const c of chunks) for (let i = 0; i < c.count; i++) {
      const lon = (c.origin[0] + c.positions[i * 3]!) * 360 - 180;
      const lat = (2 * Math.atan(Math.exp((0.5 - (c.origin[1] + c.positions[i * 3 + 1]!)) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
      const g = area.map(([a, b]) => [a, b] as [number, number]);
      const inLonLat = insideGrid(g, lon, lat);
      assert.ok(inLonLat, `a point at ${lon}, ${lat} is outside the area`);
    }
  });

  it('stops at the depth the budget allows, and reads only what it needs', async () => {
    let r = await run(everything, { budget: { maxPoints: 1000, maxBytes: 1e12 } });
    assert.equal(r.summary.depth, 0);
    assert.equal(r.summary.points, 625);
    assert.equal(r.chunks.length, 1);
    r = await run(everything, { budget: { maxPoints: 2600, maxBytes: 1e12 } });
    assert.equal(r.summary.depth, 1);
    assert.equal(r.summary.points, 625 + 1875);
    assert.equal(r.chunks.length, 5);
    r = await run(everything, { budget: { maxPoints: 1e9, maxBytes: 20_000 } }); // limited by bytes
    assert.ok(r.summary.depth < 2);
  });

  it('reads only the nodes over a small area, by range request, and never the whole file at once', async () => {
    const small = await run(gridRect(X0 + 100, Y0 + 100, X0 + 600, Y0 + 600));
    // the top node, the one quarter of the tile that holds the area, and the one sixteenth of it: three of the 21
    assert.deepEqual(small.chunks.map((c) => c.key).sort(), ['0-0-0-0', '1-0-0-0', '2-0-0-0']);
    assert.equal(small.asked.length, 3); // and only those three were even requested: the others are not over the area
    assert.ok(small.chunks.every((c) => c.count > 0));
    assert.ok(small.log.ranges.every((r) => r.end - r.begin < FIXTURE.length));
    assert.equal(small.log.search, 2); // Phase 3 first, then Phase 2, as Phase 3 had nothing
    const all = await run(everything);
    assert.ok(small.summary.points < all.summary.points / 10);
  });

  it('shows its progress: searching, reading, loading, done, with the plan known before the points arrive', async () => {
    const { progress, summary } = await run(everything);
    assert.deepEqual(progress.map((p) => p.stage).filter((s, i, a) => a.indexOf(s) === i), ['searching', 'reading', 'loading', 'done']);
    const loading = progress.find((p) => p.stage === 'loading')!;
    assert.equal(loading.plan!.nodes, 21);
    assert.ok(loading.plan!.points > 9900 && loading.plan!.points <= 10000, `${loading.plan!.points}`); // an estimate: the area is a hair smaller than the tile
    assert.equal(loading.loadedPoints, 0);
    const last = progress.at(-1)!;
    assert.equal(last.loadedPoints, summary.points);
    assert.equal(last.loadedNodes, 21);
    assert.ok(progress.every((p, i) => i === 0 || p.loadedNodes >= progress[i - 1]!.loadedNodes));
  });

  it('asks for the coarse levels first, so the map fills in from rough to fine', async () => {
    const network = fakeNetwork();
    const pool = inProcessPool(network.fetchFn);
    const asked: string[] = [];
    const decode = pool.decode.bind(pool);
    pool.decode = (m) => { asked.push(m.key); return decode(m); };
    await loadPointCloud(everything, { fetchFn: network.fetchFn, pool, loadId: 3, budget: BIG, onChunk: () => undefined });
    pool.close();
    const depths = asked.map((k) => Number(k.split('-')[0]));
    assert.equal(depths.length, 21);
    assert.deepEqual(depths, [...depths].sort((a, b) => a - b));
  });

  it('finds nothing where there is no tile, without an error', async () => {
    const network = fakeNetwork();
    const { summary } = await run(gridRect(X0 + 900_000, Y0, X0 + 901_000, Y0 + 1000), { network });
    // a tile far from the fixture's: the fake catalogue still returns the fixture's tile, but it does not touch the area
    assert.equal(summary.points, 0);
    assert.equal(summary.tiles.phase2, 0);
  });

  it('reports a tile that cannot be read, and fails if none can', async () => {
    await assert.rejects(run(everything, { network: fakeNetwork({ missing: true }) }), /None of the point-cloud files could be read: The file server answered 404/);
  });

  it('fails clearly when the file server ignores range requests, rather than downloading whole files', async () => {
    await assert.rejects(run(everything, { network: fakeNetwork({ noRange: true }) }), /None of the point-cloud files could be read: The file server does not do range requests/);
  });

  it('refuses an area over the limit', async () => {
    await assert.rejects(run(gridRect(X0, Y0, X0 + 20_000, Y0 + 20_000)), /bigger than the 4 square miles/);
  });

  it('can be cancelled part-way, and then reads no more', async () => {
    const controller = new AbortController();
    const network = fakeNetwork({ slow: 15 });
    const pool = inProcessPool(network.fetchFn);
    const seen: Chunk[] = [];
    const started = loadPointCloud(everything, { fetchFn: network.fetchFn, pool, loadId: 2, budget: BIG, signal: controller.signal, onChunk: (c) => { seen.push(c); if (seen.length === 2) controller.abort(); } });
    await assert.rejects(started, (e: Error) => e.name === 'AbortError');
    const after = network.log.ranges.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(seen.length < 21);
    assert.ok(network.log.ranges.length - after <= 4, 'requests already in flight may finish, but no new ones start');
    pool.close();
  });
});

describe('the hierarchy of a file', () => {
  const cube = [0, 0, 0, 1000, 1000, 1000];
  const page = (offset: number) => ({ pageOffset: offset, pageLength: 100 });
  const node = (count: number) => ({ pointCount: count, pointDataOffset: 1, pointDataLength: 2 });
  const loader = (pages: Record<number, { nodes: Record<string, ReturnType<typeof node>>; pages: Record<string, ReturnType<typeof page>> }>, asked: number[] = []) =>
    async (p: { pageOffset: number }) => { asked.push(p.pageOffset); return pages[p.pageOffset]!; };
  const whole: [number, number][] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];

  it('lists the nodes over the area with their footprints, and leaves out those with no points', async () => {
    const nodes = await nodesOver(loader({ 1: { nodes: { '0-0-0-0': node(50), '1-0-0-0': node(20), '1-1-1-0': node(0) }, pages: {} } }), { cube, spacing: 100, rootHierarchyPage: page(1) }, 7, whole);
    assert.deepEqual(nodes.map((n) => [n.file, n.key, n.depth, n.count]), [[7, '0-0-0-0', 0, 50], [7, '1-0-0-0', 1, 20]]);
    assert.deepEqual(nodes[1]!.box, [0, 0, 500, 500]);
    assert.deepEqual(nodes.map((n) => n.spacingFt), [100, 50]); // the file's spacing, halved for each level
  });

  it('leaves out nodes that are not over the area', async () => {
    const corner: [number, number][] = [[10, 10], [100, 10], [100, 100], [10, 100]];
    const nodes = await nodesOver(loader({ 1: { nodes: { '0-0-0-0': node(5), '1-0-0-0': node(5), '1-1-0-0': node(5), '1-1-1-0': node(5) }, pages: {} } }), { cube, spacing: 100, rootHierarchyPage: page(1) }, 0, corner);
    assert.deepEqual(nodes.map((n) => n.key), ['0-0-0-0', '1-0-0-0']);
  });

  it('reads a sub-page only where it is over the area, and follows pages into pages', async () => {
    const asked: number[] = [];
    const pages = {
      1: { nodes: { '0-0-0-0': node(5) }, pages: { '1-0-0-0': page(2), '1-1-1-0': page(3) } },
      2: { nodes: { '2-0-0-0': node(9) }, pages: { '3-0-0-0': page(4) } },
      3: { nodes: { '2-3-3-0': node(9) }, pages: {} },
      4: { nodes: { '3-0-0-0': node(9) }, pages: {} },
    };
    const west: [number, number][] = [[0, 0], [400, 0], [400, 400], [0, 400]]; // over the '1-0-0-0' page and not the '1-1-1-0' one
    const nodes = await nodesOver(loader(pages, asked), { cube, spacing: 100, rootHierarchyPage: page(1) }, 0, west);
    assert.deepEqual(nodes.map((n) => n.key).sort(), ['0-0-0-0', '2-0-0-0', '3-0-0-0']);
    assert.deepEqual(asked.sort(), [1, 2, 4]); // page 3 was never read
  });
});

describe('a network that drops requests', () => {
  const answer = (status: number, body = new Uint8Array([1, 2, 3])) => new Response(status === 206 ? body : '', { status });
  const calls = (script: (Response | Error)[]) => {
    let n = 0;
    return { n: () => n, fetchFn: async () => { const next = script[n++] ?? script.at(-1)!; if (next instanceof Error) throw next; return next.clone(); } };
  };

  it('tries a range request again after a dropped connection, and after the server\'s 429 or 5xx, and gets the bytes', async () => {
    for (const first of [new TypeError('Failed to fetch'), answer(503), answer(429), answer(500)]) {
      const net = calls([first, first, answer(206)]);
      const bytes = await rangeGetter(net.fetchFn, 'https://x.example/a/Tile_1.copc.laz', undefined, undefined, NO_WAIT)(0, 3);
      assert.deepEqual(Array.from(bytes), [1, 2, 3]);
      assert.equal(net.n(), 3);
    }
  });

  it('gives up after the third try and says which file and why', async () => {
    const dropped = calls([new TypeError('Failed to fetch')]);
    await assert.rejects(rangeGetter(dropped.fetchFn, 'https://x.example/a/Tile_1.copc.laz', undefined, undefined, NO_WAIT)(0, 3), /The file server could not be reached for Tile_1\.copc\.laz \(Failed to fetch\)/);
    assert.equal(dropped.n(), 3);
    const busy = calls([answer(503)]);
    await assert.rejects(rangeGetter(busy.fetchFn, 'https://x.example/a/Tile_1.copc.laz', undefined, undefined, NO_WAIT)(0, 3), /The file server answered 503 for Tile_1\.copc\.laz/);
  });

  it('does not try again when a second try could not help: a 403 or 404, or a server that ignores Range', async () => {
    for (const [status, message] of [[404, /answered 404 for Tile_1/], [403, /answered 403/], [200, /does not do range requests/]] as const) {
      const net = calls([answer(status)]);
      await assert.rejects(rangeGetter(net.fetchFn, 'https://x.example/a/Tile_1.copc.laz', undefined, undefined, NO_WAIT)(0, 3), message);
      assert.equal(net.n(), 1);
    }
  });

  it('waits between tries, longer each time, and stops waiting when cancelled', async () => {
    assert.deepEqual([RETRY.attempts, RETRY.delayMs], [3, 400]);
    const started = Date.now();
    const net = calls([new TypeError('Failed to fetch'), answer(206)]);
    await rangeGetter(net.fetchFn, 'https://x.example/a/Tile_1.copc.laz', undefined, undefined, { attempts: 3, delayMs: 60 })(0, 3);
    assert.ok(Date.now() - started >= 55);
    const slow = calls([new TypeError('Failed to fetch')]);
    const began = Date.now();
    await assert.rejects(rangeGetter(slow.fetchFn, 'https://x.example/a/Tile_1.copc.laz', undefined, undefined, { attempts: 3, delayMs: 50 })(0, 3));
    assert.ok(Date.now() - began >= 145, `${Date.now() - began} ms`); // it waited 50 ms and then 100 ms: longer each time
    const controller = new AbortController();
    const dropped = calls([new TypeError('Failed to fetch')]);
    const pending = rangeGetter(dropped.fetchFn, 'https://x.example/a/Tile_1.copc.laz', controller.signal, undefined, { attempts: 3, delayMs: 5000 })(0, 3);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (e: Error) => e.name === 'AbortError');
    assert.equal(dropped.n(), 1);
  });

  it('a load over a network that drops every third request still gets everything', async () => {
    const { summary } = await run(gridRect(X0 + 1, Y0 + 1, X0 + 4999, Y0 + 4999), { network: fakeNetwork({ dropEvery: 3 }) });
    assert.equal(summary.points, 10000);
    assert.equal(summary.failedNodes, 0);
  });

  it('one block that cannot be fetched does not end the load: the rest is shown, and it is counted', async () => {
    const network = fakeNetwork();
    const pool = inProcessPool(network.fetchFn);
    const decode = pool.decode.bind(pool);
    pool.decode = (m) => (m.key === '2-1-1-0' ? Promise.reject(new Error('The file server could not be reached for Tile.copc.laz (Failed to fetch).')) : decode(m));
    const chunks: Chunk[] = [];
    const progress: Progress[] = [];
    const summary = await loadPointCloud(gridRect(X0 + 1, Y0 + 1, X0 + 4999, Y0 + 4999), { fetchFn: network.fetchFn, pool, loadId: 9, retry: NO_WAIT, budget: BIG, onChunk: (c) => chunks.push(c), onProgress: (p) => progress.push(p) });
    pool.close();
    assert.equal(summary.failedNodes, 1);
    assert.equal(summary.points, 10000 - lattice().filter((p) => p.level === 2 && p.x - X0 >= 1250 && p.x - X0 < 2500 && p.y - Y0 >= 1250 && p.y - Y0 < 2500).length);
    assert.equal(chunks.length, 20);
    assert.equal(progress.at(-1)!.loadedNodes, 21); // it counted the failed one as done, so the count reaches the total
  });

  it('but a load in which every block fails is a failure, with the reason', async () => {
    const network = fakeNetwork();
    const pool = inProcessPool(network.fetchFn);
    pool.decode = () => Promise.reject(new Error('The file server could not be reached for Tile.copc.laz (Failed to fetch).'));
    await assert.rejects(
      loadPointCloud(gridRect(X0 + 1, Y0 + 1, X0 + 4999, Y0 + 4999), { fetchFn: network.fetchFn, pool, loadId: 10, retry: NO_WAIT, budget: BIG, onChunk: () => undefined }),
      /None of the point-cloud blocks could be read: The file server could not be reached for Tile\.copc\.laz/,
    );
    pool.close();
  });
});
