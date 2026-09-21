// A made-up KyFromAbove for the point-cloud tests: a STAC catalogue that has one tile, and a file server that serves the tiny COPC file by
// range request, and workers that run in this process instead of in a browser.
import { readFileSync } from 'node:fs';
import { gridToLonLat } from '../../src/lcc.ts';
import { rangeGetter } from '../../src/pc-load.ts';
import { WorkerPool, type WorkerLike } from '../../src/pc-pool.ts';
import type { Fetch } from '../../src/pc-stac.ts';
import { NodeDecoder, type WorkerReply } from '../../src/pc-worker-core.ts';

export const FIXTURE = readFileSync(new URL('../fixtures/tiny.copc.laz', import.meta.url));
/** The fixture's tile on the grid (see make_copc.py). */
export const X0 = 4_914_999.99, Y0 = 3_974_999.99;
export const NO_WAIT = { attempts: 3, delayMs: 0 };
export const TILE_URL = 'https://kyfromabove.example/elevation/PointCloud/Phase2/N077E228_LAS_Phase2.copc.laz';

export const tileItem = (phase: 2 | 3 = 2, href = TILE_URL) => ({
  id: `N077E228_LAS_Phase${phase}.copc`, bbox: [0, 0, 0, 0],
  properties: {
    'proj:bbox': [X0, Y0, X0 + 5000, Y0 + 5000], 'pc:count': 10000, datetime: '2024-01-22T00:00:00Z',
    'proj:wkt2': 'COMPOUNDCRS["NAD83 / Kentucky Single Zone (ftUS) + NAVD88 height (ftUS) - Geoid12B (ftUS)"]',
  },
  assets: { pointcloud: { href } },
});

export interface Log { search: number; ranges: { url: string; begin: number; end: number }[]; bytes: number }

/** A fetch that answers STAC searches (Phase 2 has the tile, Phase 3 nothing) and range requests for the file. */
export function fakeNetwork(opts: { missing?: boolean; slow?: number; noRange?: boolean; flaky?: number; dropEvery?: number } = {}): { fetchFn: Fetch; log: Log } {
  let flaky = opts.flaky ?? 0;
  let requests = 0;
  const log: Log = { search: 0, ranges: [], bytes: 0 };
  const fetchFn: Fetch = async (url, init) => {
    if (init?.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    if (url.endsWith('/search')) {
      log.search++;
      const body = JSON.parse(String(init?.body)) as { collections: string[] };
      return Response.json({ features: body.collections[0] === 'laz-phase2' ? [tileItem(2)] : [] });
    }
    if (opts.slow) await new Promise((r) => setTimeout(r, opts.slow));
    if (flaky > 0) { flaky--; throw new TypeError('Failed to fetch'); } // a dropped connection
    if (opts.dropEvery && ++requests % opts.dropEvery === 0) throw new TypeError('Failed to fetch'); // and one every so often
    if (opts.missing) return new Response('', { status: 404 });
    if (opts.noRange) return new Response(FIXTURE, { status: 200 }); // a server that ignores the Range header
    const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '');
    if (!range) return new Response(FIXTURE, { status: 200 });
    const begin = Number(range[1]), end = Math.min(Number(range[2]) + 1, FIXTURE.length);
    log.ranges.push({ url, begin, end });
    log.bytes += end - begin;
    return new Response(FIXTURE.subarray(begin, end), { status: 206 });
  };
  return { fetchFn, log };
}

/** Workers that run here, on the same fake file server. */
export function inProcessPool(fetchFn: Fetch, size = 2): WorkerPool {
  return new WorkerPool(() => {
    const decoder = new NodeDecoder((url) => rangeGetter(fetchFn, url, undefined, undefined, NO_WAIT));
    let reply: (r: WorkerReply) => void = () => undefined;
    const worker: WorkerLike = {
      post: (m) => { void decoder.handle(m).then((r) => { if (r) reply(r); }); },
      onReply: (cb) => { reply = cb; },
      close: () => undefined,
    };
    return worker;
  }, size);
}

/** The fixture's points in the order the generator made them: x, y and height, from its own formula (make_copc.py), and which level each is in. */
export function lattice(): { x: number; y: number; z: number; level: number; cls: number }[] {
  const out = [];
  for (let i = 0; i < 100; i++) {
    for (let j = 0; j < 100; j++) {
      const x = X0 + (i + 0.5) * 50, y = Y0 + (j + 0.5) * 50;
      const building = Math.abs(x - (X0 + 2500)) < 300 && Math.abs(y - (Y0 + 2500)) < 300;
      const z = 420 + 20 * Math.sin((x - X0) / 700) * Math.cos((y - Y0) / 900) + (building ? 40 : 0);
      const level = i % 4 === 0 && j % 4 === 0 ? 0 : i % 2 === 0 && j % 2 === 0 ? 1 : 2;
      out.push({ x, y, z, level, cls: building ? 6 : 2 });
    }
  }
  return out;
}

/** A rectangle on the grid as a polygon of longitude and latitude. */
export const gridRect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => gridToLonLat(x!, y!));
