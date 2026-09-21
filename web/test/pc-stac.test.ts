import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gridToLonLat } from '../src/lcc.ts';
import type { LonLat } from '../src/pc-aoi.ts';
import { findPointClouds, MAX_ITEMS, samplePoints, STAC_URL, type Fetch } from '../src/pc-stac.ts';

const ring = (x0: number, y0: number, w: number, h: number): LonLat[] => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]].map(([x, y]) => gridToLonLat(x!, y!));

/** A STAC item shaped like the state's: an id, the tile on the grid in `proj:bbox`, its size, a datetime, its coordinate system, and one `pointcloud` asset. */
function item(phase: 2 | 3, col: number, row: number, extra: Record<string, unknown> = {}) {
  const x = 4_910_000 + col * 5000, y = 3_975_000 + row * 5000;
  return {
    id: `N${row}E${col}_LAS_Phase${phase}.copc`,
    bbox: [0, 0, 0, 0],
    properties: {
      'proj:bbox': [x - 0.01, y - 0.01, x + 4999.99, y + 5000], 'pc:count': 10_000_000 + col, datetime: '2024-01-22T00:00:00Z',
      'proj:wkt2': 'COMPOUNDCRS["NAD83 / Kentucky Single Zone (ftUS) + NAVD88 height (ftUS) - Geoid12B (ftUS)"]', ...extra,
    },
    assets: { pointcloud: { href: `https://bucket.example/elevation/PointCloud/Phase${phase}/N${row}E${col}_LAS_Phase${phase}.copc.laz` } },
  };
}

/** A fake catalogue: what each collection has (by tile), the requests it was sent, and an optional second page. */
function catalogue(collections: Record<string, unknown[]>, opts: { status?: number; pages?: Record<string, unknown[][]> } = {}) {
  const requests: { url: string; body: { collections: string[]; intersects: { type: string; coordinates: number[][][] }; limit: number; token?: string } }[] = [];
  const fetchFn: Fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    if (opts.status) return new Response('nope', { status: opts.status });
    const id = body.collections[0] as string;
    const pages = opts.pages?.[id];
    if (pages) {
      const page = body.token ? Number(body.token) : 0;
      return Response.json({ features: pages[page], links: page + 1 < pages.length ? [{ rel: 'next', method: 'POST', body: { token: String(page + 1) } }] : [] });
    }
    return Response.json({ features: collections[id] ?? [], links: [] });
  };
  return { fetchFn, requests };
}

// The area used below is the 5,000 ft tile at column 1, row 1 and half of the tile to its east, so it touches two tiles of one phase.
const AREA = ring(4_915_000 + 500, 3_980_000 + 500, 6000, 3000); // x 4,915,500 to 4,921,500; y 3,980,500 to 3,983,500

describe('finding the point clouds for an area', () => {
  it('asks Phase 3 first, with the area as a closed GeoJSON polygon, and needs no more if Phase 3 covers it all', async () => {
    const { fetchFn, requests } = catalogue({ 'laz-phase3': [item(3, 1, 1), item(3, 2, 1), item(3, 0, 0)] });
    const found = await findPointClouds(AREA, fetchFn);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, `${STAC_URL}/search`);
    assert.deepEqual(requests[0]!.body.collections, ['laz-phase3']);
    const poly = requests[0]!.body.intersects;
    assert.equal(poly.type, 'Polygon');
    assert.equal(poly.coordinates[0]!.length, 5);
    assert.deepEqual(poly.coordinates[0]![0], poly.coordinates[0]![4]);
    assert.ok(poly.coordinates[0]![0]![0]! < -80 && poly.coordinates[0]![0]![0]! > -90); // longitude first
    assert.deepEqual(found.items.map((i) => [i.phase, i.id]), [[3, 'N1E1_LAS_Phase3.copc'], [3, 'N1E2_LAS_Phase3.copc']]); // the tile far away is not taken even if the catalogue sent it
    assert.equal(found.skipped, 0);
  });

  it('gives the tile as it is on the grid, the file, the size and the date', async () => {
    const { fetchFn } = catalogue({ 'laz-phase3': [item(3, 1, 1)] });
    const [it0] = (await findPointClouds(ring(4_915_500, 3_980_500, 1000, 1000), fetchFn)).items;
    assert.equal(it0!.href, 'https://bucket.example/elevation/PointCloud/Phase3/N1E1_LAS_Phase3.copc.laz');
    assert.deepEqual(it0!.box, [4_914_999.99, 3_979_999.99, 4_919_999.99, 3_980_000 + 5000]);
    assert.equal(it0!.count, 10_000_001);
    assert.equal(it0!.datetime, '2024-01-22T00:00:00Z');
  });

  it('falls back to Phase 2 for the ground Phase 3 does not cover, and only for that ground', async () => {
    // Phase 3 has the west tile (col 1) only; Phase 2 has both, and another far away
    const { fetchFn, requests } = catalogue({ 'laz-phase3': [item(3, 1, 1)], 'laz-phase2': [item(2, 1, 1), item(2, 2, 1), item(2, 5, 5)] });
    const found = await findPointClouds(AREA, fetchFn);
    assert.deepEqual(requests.map((r) => r.body.collections[0]), ['laz-phase3', 'laz-phase2']);
    assert.deepEqual(found.items.map((i) => `${i.phase}:${i.id}`), ['3:N1E1_LAS_Phase3.copc', '2:N1E2_LAS_Phase2.copc']); // Phase 2's copy of the west tile is not used
  });

  it('uses Phase 2 alone where Phase 3 has nothing (as at Louisville)', async () => {
    const { fetchFn } = catalogue({ 'laz-phase3': [], 'laz-phase2': [item(2, 1, 1), item(2, 2, 1)] });
    const found = await findPointClouds(AREA, fetchFn);
    assert.deepEqual(found.items.map((i) => i.phase), [2, 2]);
  });

  it('finds nothing where neither has anything', async () => {
    const found = await findPointClouds(AREA, catalogue({}).fetchFn);
    assert.deepEqual(found.items, []);
  });

  it('follows the catalogue to its next page', async () => {
    const { fetchFn, requests } = catalogue({}, { pages: { 'laz-phase3': [[item(3, 1, 1)], [item(3, 2, 1)]] } });
    const found = await findPointClouds(AREA, fetchFn);
    assert.equal(found.items.length, 2);
    assert.equal(requests.filter((r) => r.body.collections[0] === 'laz-phase3').length, 2);
    assert.equal(requests[1]!.body.token, '1');
    assert.deepEqual(requests[1]!.body.collections, ['laz-phase3']); // the rest of the search is kept
  });

  it('skips a tile that is not in the Kentucky Single Zone, and counts it', async () => {
    const foreign = item(3, 1, 1, { 'proj:wkt2': 'COMPOUNDCRS["NAD83 / UTM zone 16N + NAVD88 height"]' });
    const found = await findPointClouds(AREA, catalogue({ 'laz-phase3': [foreign, item(3, 2, 1)] }).fetchFn);
    assert.deepEqual(found.items.map((i) => i.id), ['N1E2_LAS_Phase3.copc']);
    assert.equal(found.skipped, 1);
  });

  it('ignores an item with no file, and works out a tile from its longitude and latitude if it has no grid box', async () => {
    const noFile = { ...item(3, 1, 1), assets: {} };
    const noGrid = item(3, 2, 1);
    delete (noGrid.properties as Record<string, unknown>)['proj:bbox'];
    noGrid.bbox = [...gridToLonLat(4_920_000, 3_980_000), ...gridToLonLat(4_925_000, 3_985_000)];
    const found = await findPointClouds(AREA, catalogue({ 'laz-phase3': [noFile, noGrid] }).fetchFn);
    assert.equal(found.items.length, 1);
    assert.ok(Math.abs(found.items[0]!.box[0] - 4_920_000) < 5 && Math.abs(found.items[0]!.box[3] - 3_985_000) < 5);
  });

  it('refuses an area that needs too many tiles', async () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => item(3, 1 + (i % 6), 1 + Math.floor(i / 6)));
    await assert.rejects(findPointClouds(ring(4_910_000, 3_980_000, 40_000, 40_000), catalogue({ 'laz-phase3': many }).fetchFn), /more than the 24 allowed/);
  });

  it('reports a catalogue that is down, and passes the cancel signal on', async () => {
    await assert.rejects(findPointClouds(AREA, catalogue({}, { status: 503 }).fetchFn), /answered 503/);
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await findPointClouds(AREA, async (_u, init) => { seen = init?.signal ?? undefined; return Response.json({ features: [] }); }, controller.signal);
    assert.equal(seen, controller.signal);
  });

  it('samples the ground evenly, inside the area only', () => {
    const points = samplePoints(AREA);
    assert.equal(points.length, 576); // a rectangle on the grid: every sample is inside
    assert.ok(points.every(([x, y]) => x > 4_915_500 && x < 4_921_500 && y > 3_980_500 && y < 3_983_500));
    const triangle = samplePoints([gridToLonLat(4_915_000, 3_980_000), gridToLonLat(4_925_000, 3_980_000), gridToLonLat(4_915_000, 3_990_000)]);
    assert.ok(triangle.length > 250 && triangle.length < 320); // about half of the 576
  });
});
