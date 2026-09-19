// Runs against the real local PostGIS (docker compose up -d postgis, after pipeline/load_postgis.sh),
// through the same read-only role the API uses. Nothing is mocked.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createPool } from '../src/db.ts';
import { parseLook } from '../src/look.ts';

const IMAGE_BASE = 'https://example.test/obliques/';
const pool = createPool();
let app: FastifyInstance;
let lon = 0;
let lat = 0;

// Ray casting on a GeoJSON polygon ring of [lon, lat] pairs.
function inside(x: number, y: number, ring: number[][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const get = (url: string) => app.inject({ method: 'GET', url });

before(async () => {
  try {
    // A point inside a known Color footprint, picked the same way pipeline/postgis/checks.sql does.
    const { rows } = await pool.query<{ lon: number; lat: number }>(`
      SELECT ST_X(ST_Transform(p, 4326)) AS lon, ST_Y(ST_Transform(p, 4326)) AS lat
      FROM (SELECT ST_PointOnSurface(geom) AS p FROM frames WHERE camera = 'Color' ORDER BY filename OFFSET 500 LIMIT 1) t`);
    ({ lon, lat } = rows[0]!);
  } catch (error) {
    throw new Error(`cannot reach the local PostGIS as viewer_ro. Start it with "docker compose up -d postgis" and load it with pipeline/load_postgis.sh (${(error as Error).message})`);
  }
  app = buildApp({ pool, imageBase: IMAGE_BASE, cacheSeconds: 60 });
});

after(async () => {
  await app.close();
  await pool.end();
});

describe('parseLook', () => {
  it('reads names, wraps bearings, and rejects the rest', () => {
    assert.deepEqual(parseLook('North'), { label: 'north', azimuth: 0 });
    assert.deepEqual(parseLook('west'), { label: 'west', azimuth: 270 });
    assert.deepEqual(parseLook('down'), { label: 'down', azimuth: null });
    assert.equal(parseLook('45')?.azimuth, 45);
    assert.equal(parseLook('-90')?.azimuth, 270);
    assert.equal(parseLook('450')?.azimuth, 90);
    assert.equal(parseLook('sideways'), null);
    assert.equal(parseLook('constructor'), null);
    assert.equal(parseLook('1e3'), null);
    assert.equal(parseLook(''), null);
  });
});

describe('GET /api/health', () => {
  it('answers ok when the database is reachable', async () => {
    const res = await get('/api/health');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });

  it('answers 503, without database details, when it is not', async () => {
    const dead = buildApp({ pool: createPool({ ...process.env, PGPORT: '59999' }), imageBase: IMAGE_BASE, cacheSeconds: 0 });
    const res = await dead.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: 'database_unavailable' });
    await dead.close();
  });
});

describe('GET /api/frames', () => {
  it('returns ranked oblique frames for a compass direction', async () => {
    const res = await get(`/api/frames?lon=${lon}&lat=${lat}&look=north&limit=5`);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['cache-control']), /max-age=60/);
    const body = res.json();
    assert.deepEqual(body.query, { lon, lat, look: 'north', azimuth: 0, limit: 5 });
    assert.ok(body.frames.length >= 1 && body.frames.length <= 5);
    body.frames.forEach((f: { pick: number; camera: string; url: string; filename: string; flownUtc: string }, i: number) => {
      assert.equal(f.pick, i + 1);
      assert.notEqual(f.camera, 'Color');
      assert.equal(f.url, IMAGE_BASE + f.filename);
      assert.match(f.flownUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
    const first = body.frames[0];
    assert.equal(typeof first.azOk, 'boolean');
    assert.equal(typeof first.eligible, 'boolean');
    assert.equal(typeof first.isReflight, 'boolean');
    // A well-covered point: the top pick looks roughly north.
    assert.ok(first.azOk && first.azOff < 30, `top pick is ${first.azOff} degrees off`);
  });

  it('returns only Color frames when looking down, and defaults to that', async () => {
    for (const url of [`/api/frames?lon=${lon}&lat=${lat}&look=down`, `/api/frames?lon=${lon}&lat=${lat}`]) {
      const body = (await get(url)).json();
      assert.ok(body.frames.length >= 1);
      assert.ok(body.frames.every((f: { camera: string }) => f.camera === 'Color'));
      assert.equal(body.query.azimuth, null);
    }
  });

  it('accepts a bearing and wraps it', async () => {
    const body = (await get(`/api/frames?lon=${lon}&lat=${lat}&look=-90`)).json();
    assert.equal(body.query.azimuth, 270);
  });

  it('returns an empty list, not an error, outside the imagery', async () => {
    const res = await get('/api/frames?lon=-100&lat=30&look=north');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().frames, []);
  });

  it('rejects bad input with a 400', async () => {
    const bad = [
      '/api/frames',
      `/api/frames?lat=${lat}`,
      `/api/frames?lon=${lon}`,
      `/api/frames?lon=abc&lat=${lat}`,
      `/api/frames?lon=999&lat=${lat}`,
      `/api/frames?lon=${lon}&lat=91`,
      `/api/frames?lon=${lon}&lat=${lat}&look=sideways`,
      `/api/frames?lon=${lon}&lat=${lat}&look=${'x'.repeat(40)}`,
      `/api/frames?lon=${lon}&lat=${lat}&limit=0`,
      `/api/frames?lon=${lon}&lat=${lat}&limit=21`,
      `/api/frames?lon=${lon}&lat=${lat}&limit=2.5`,
    ];
    for (const url of bad) {
      const res = await get(url);
      assert.equal(res.statusCode, 400, `${url} gave ${res.statusCode}`);
      assert.equal(res.json().error, 'bad_request');
    }
  });

  it('does not let a query string reach the SQL', async () => {
    const res = await get(`/api/frames?lon=${lon}&lat=${lat}&look=${encodeURIComponent("north'; DROP TABLE frames;--")}`);
    assert.equal(res.statusCode, 400);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM frames')).rows[0].n > 0, true);
  });
});

describe('GET /api/frames/:season/:name', () => {
  let top: { filename: string; camera: string };

  before(async () => {
    top = (await get(`/api/frames?lon=${lon}&lat=${lat}&look=east`)).json().frames[0];
  });

  it('returns the full frame, and the clicked point lies inside its footprint', async () => {
    const res = await get(`/api/frames/${top.filename}`);
    assert.equal(res.statusCode, 200);
    const d = res.json();
    assert.equal(d.filename, top.filename);
    assert.equal(d.url, IMAGE_BASE + top.filename);
    assert.equal(d.sidecarUrl, IMAGE_BASE + top.filename.replace('.tif', '.json'));
    assert.equal(d.camera, top.camera);
    for (const key of ['x', 'y', 'z', 'omega', 'phi', 'kappa', 'lon', 'lat']) assert.equal(typeof d.eo[key], 'number', key);
    assert.ok(d.eo.lon > -90 && d.eo.lon < -81 && d.eo.lat > 36 && d.eo.lat < 40, 'camera position is in Kentucky');
    assert.ok(d.sensor.widthPx > 0 && d.sensor.heightPx > 0 && d.sensor.focalMm > 0 && d.sensor.ccdResUm > 0);
    // Five corners (closed ring), in feet, with a Z.
    assert.equal(d.footprint3089.length, 5);
    assert.ok(d.footprint3089.every((c: number[]) => c.length === 3 && c.every(Number.isFinite)));
    // The WGS84 footprint round-trips: the point we asked about is inside it.
    assert.equal(d.footprintLonLat.type, 'Polygon');
    assert.ok(inside(lon, lat, d.footprintLonLat.coordinates[0]), 'the clicked point is inside the footprint');
  });

  it('answers 404 for a well-formed name that does not exist', async () => {
    const res = await get('/api/frames/KY_KYAPED_2023_Season1_3IN/Fwd_9999_9999999.tif');
    assert.equal(res.statusCode, 404);
  });

  it('rejects malformed names with a 400 before touching the database', async () => {
    for (const path of [
      "KY_KYAPED_2023_Season1_3IN/Fwd_1_1.tif'--",
      'KY_KYAPED_2023_Season1_3IN/Sideways_1_1.tif',
      'KY_KYAPED_2023_Season1_3IN/..%2F..%2Fetc',
      'not_a_season/Fwd_1_1.tif',
    ]) {
      const res = await get(`/api/frames/${path}`);
      assert.ok(res.statusCode === 400 || res.statusCode === 404, `${path} gave ${res.statusCode}`);
      assert.notEqual(res.statusCode, 200);
    }
  });

  it('returns neighbors in shot order, each a plausible distance away', async () => {
    const res = await get(`/api/frames/${top.filename}/neighbors`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.filename, top.filename);
    const self = (await get(`/api/frames/${top.filename}`)).json();
    for (const n of body.neighbors) {
      assert.ok(n.direction === 'next' || n.direction === 'prev');
      assert.equal(n.url, IMAGE_BASE + n.filename);
      assert.ok(n.direction === 'next' ? n.shot > self.shot : n.shot < self.shot);
      assert.ok(n.distFt > 0 && n.distFt <= 3000);
    }
    assert.ok(body.neighbors.length >= 1, 'a frame in the middle of a pass has a neighbor');
  });

  it('answers 404 for the neighbors of a frame that does not exist', async () => {
    assert.equal((await get('/api/frames/KY_KYAPED_2023_Season1_3IN/Fwd_9999_9999999.tif/neighbors')).statusCode, 404);
  });
});

describe('database permissions', () => {
  it('the API role cannot write', async () => {
    await assert.rejects(pool.query('DELETE FROM frames WHERE false'), /read-only|permission denied/);
    await assert.rejects(pool.query('CREATE TABLE api_should_not_exist (x int)'), /read-only|permission denied/);
  });
});

describe('GET /api/scene', () => {
  // A view 600 ft across around the test point: small, like a close zoom.
  const view = () => `west=${lon - 0.0009}&south=${lat - 0.0007}&east=${lon + 0.0009}&north=${lat + 0.0007}`;

  it('returns the frames for the view, best first, each looking the wanted way', async () => {
    const res = await get(`/api/scene?${view()}&look=north`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.query.look, 'north');
    assert.ok(body.frames.length >= 1 && body.frames.length <= 6, `${body.frames.length} frames`);
    for (const f of body.frames) {
      assert.ok(f.lookAzimuth !== null && Math.min(f.lookAzimuth, 360 - f.lookAzimuth) <= 30, `${f.filename} looks ${f.lookAzimuth}`);
      assert.ok(f.url.startsWith(IMAGE_BASE) && f.url.endsWith(f.filename));
      assert.equal(f.footprint3089.length, 4);
      assert.ok(f.sensor.widthPx > 1000 && f.sensor.focalMm > 0 && Number.isFinite(f.eo.omega));
    }
    const wins = body.frames.map((f: { wins: number }) => f.wins);
    assert.deepEqual(wins, [...wins].sort((a: number, b: number) => b - a), 'ranked by wins');
  });

  it('includes the best frame for the middle of the view (the list\'s own top pick)', async () => {
    const list = (await get(`/api/frames?lon=${lon}&lat=${lat}&look=north&limit=1`)).json().frames;
    if (list.length === 0 || !list[0].azOk) return; // nothing looks north here; the test point is a Color-footprint point
    const scene = (await get(`/api/scene?${view()}&look=north&limit=12`)).json().frames;
    assert.ok(scene.some((f: { filename: string }) => f.filename === list[0].filename), 'the middle point\'s pick is among the winners');
  });

  it('returns an empty list where nothing looks that way, and for a view outside the imagery', async () => {
    const out = (await get('/api/scene?west=-100.001&south=30&east=-100&north=30.001&look=north')).json();
    assert.deepEqual(out.frames, []);
  });

  it('accepts a bearing, and wraps it', async () => {
    const a = (await get(`/api/scene?${view()}&look=90`)).json();
    assert.equal(a.query.azimuth, 90);
    const b = (await get(`/api/scene?${view()}&look=450`)).json();
    assert.equal(b.query.azimuth, 90);
  });

  it('rejects bad input with a 400: down, a reversed or oversized view, missing parts', async () => {
    for (const q of [
      `${view()}&look=down`, `${view()}&look=sideways`,
      `west=${lon + 0.001}&south=${lat}&east=${lon}&north=${lat + 0.001}&look=north`, // west of east
      `west=${lon}&south=${lat}&east=${lon + 0.5}&north=${lat + 0.001}&look=north`, // far too wide
      `west=${lon}&south=${lat}&east=${lon + 0.001}&look=north`, // no north
      `${view()}&look=north&limit=99`,
    ]) {
      assert.equal((await get(`/api/scene?${q}`)).statusCode, 400, q);
    }
  });

  it('does not let a query string reach the SQL', async () => {
    const res = await get(`/api/scene?${view()}&look=north'; DROP TABLE frames;--`);
    assert.equal(res.statusCode, 400);
    assert.equal((await get(`/api/scene?${view()}&look=north`)).statusCode, 200); // and the table is still there
  });
});
