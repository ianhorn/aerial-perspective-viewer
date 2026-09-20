import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { frameDetail, frameNeighbors, framesAtPoint, sceneFrames } from './frames.ts';
import { parseLook } from './look.ts';

export interface AppOptions {
  pool: pg.Pool;
  /** Where the COGs and their sidecars live. Ends with a slash. */
  imageBase: string;
  /** Cache-Control max-age for responses. The data never changes, so this is safe to raise. */
  cacheSeconds: number;
  logger?: boolean;
}

// A frame file name is <season folder>/<camera>_<...>.tif. The strict patterns also mean nothing
// odd ever reaches the database, although every query is parameterised anyway.
const SEASON = '^KY_KYAPED_\\d{4}_Season\\d_3IN$';
const NAME = '^(Color|Fwd|Bwd|Left|Right)_[0-9_]{1,40}\\.tif$';

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const cache = `public, max-age=${opts.cacheSeconds}`;

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown; code?: string }, request, reply) => {
    if (error.validation) return reply.code(400).send({ error: 'bad_request', message: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'bad_request', message: error.message });
    request.log.error(error);
    // Do not leak database details. A refused connection or a timeout means the database is not ready.
    const unavailable = /ECONNREFUSED|ETIMEDOUT|terminating connection|timeout|the database system/i.test(`${error.code ?? ''} ${error.message}`);
    return reply.code(unavailable ? 503 : 500).send({ error: unavailable ? 'database_unavailable' : 'internal_error' });
  });

  app.get('/api/health', async (_request, reply) => {
    await opts.pool.query('SELECT 1');
    return reply.header('Cache-Control', 'no-store').send({ status: 'ok' });
  });

  // The frames that cover a point, best first.
  app.get<{ Querystring: { lon: number; lat: number; look: string; limit: number } }>('/api/frames', {
    schema: {
      querystring: {
        type: 'object',
        required: ['lon', 'lat'],
        additionalProperties: false,
        properties: {
          lon: { type: 'number', minimum: -180, maximum: 180 },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          look: { type: 'string', maxLength: 12, default: 'down' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        },
      },
    },
  }, async (request, reply) => {
    const { lon, lat, look: rawLook, limit } = request.query;
    const look = parseLook(rawLook);
    if (!look) {
      return reply.code(400).send({ error: 'bad_request', message: 'look must be north, east, south, west, down, or a bearing in degrees' });
    }
    const frames = await framesAtPoint(opts.pool, opts.imageBase, lon, lat, look.azimuth, limit);
    return reply.header('Cache-Control', cache).send({
      query: { lon, lat, look: look.label, azimuth: look.azimuth, limit },
      frames,
    });
  });

  // The frames to show for a map view, when it is looked at from one direction: the best for each part of the view.
  app.get<{ Querystring: { west: number; south: number; east: number; north: number; look: string; limit: number } }>('/api/scene', {
    schema: {
      querystring: {
        type: 'object',
        required: ['west', 'south', 'east', 'north', 'look'],
        additionalProperties: false,
        properties: {
          west: { type: 'number', minimum: -180, maximum: 180 },
          south: { type: 'number', minimum: -90, maximum: 90 },
          east: { type: 'number', minimum: -180, maximum: 180 },
          north: { type: 'number', minimum: -90, maximum: 90 },
          look: { type: 'string', maxLength: 12 },
          limit: { type: 'integer', minimum: 1, maximum: 12, default: 6 },
        },
      },
    },
  }, async (request, reply) => {
    const { west, south, east, north, look: rawLook, limit } = request.query;
    const look = parseLook(rawLook);
    if (!look || look.azimuth === null) {
      return reply.code(400).send({ error: 'bad_request', message: 'look must be north, east, south, west, or a bearing in degrees' });
    }
    // A view is at most about 4 miles across: it is meant for close zoom, and a bigger one would be a costly query.
    if (!(east > west && north > south) || east - west > 0.08 || north - south > 0.08) {
      return reply.code(400).send({ error: 'bad_request', message: 'the view must have west < east and south < north, and be no more than 0.08 degrees across' });
    }
    const frames = await sceneFrames(opts.pool, opts.imageBase, { west, south, east, north }, look.azimuth, limit);
    return reply.header('Cache-Control', cache).send({ query: { west, south, east, north, look: look.label, azimuth: look.azimuth, limit }, frames });
  });

  const frameParams = {
    type: 'object',
    required: ['season', 'name'],
    properties: { season: { type: 'string', pattern: SEASON }, name: { type: 'string', pattern: NAME } },
  } as const;

  // One frame in full: the exterior orientation, the lens data, and the footprint.
  app.get<{ Params: { season: string; name: string } }>('/api/frames/:season/:name', { schema: { params: frameParams } }, async (request, reply) => {
    const detail = await frameDetail(opts.pool, opts.imageBase, `${request.params.season}/${request.params.name}`);
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return reply.header('Cache-Control', cache).send(detail);
  });

  // The frames before and after this one along its pass, same camera. A missing side means the end of the pass or a gap.
  app.get<{ Params: { season: string; name: string } }>('/api/frames/:season/:name/neighbors', { schema: { params: frameParams } }, async (request, reply) => {
    const filename = `${request.params.season}/${request.params.name}`;
    const exists = await opts.pool.query('SELECT 1 FROM frames WHERE filename = $1', [filename]);
    if (exists.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    const neighbors = await frameNeighbors(opts.pool, opts.imageBase, filename);
    return reply.header('Cache-Control', cache).send({ filename, neighbors });
  });

  return app;
}
