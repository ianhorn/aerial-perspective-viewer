import pg from 'pg';

// timestamp without time zone: keep the text; the mapper turns it into an ISO string. int8: our
// counts and shot numbers are far below 2^53.
pg.types.setTypeParser(1114, (value) => value);
pg.types.setTypeParser(20, (value) => Number(value));

/**
 * The connection defaults match docker-compose.yml and pipeline/postgis/roles.sql: the local
 * PostGIS on port 5433, as the read-only role viewer_ro. Override with the usual PG* variables.
 */
export function createPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  return new pg.Pool({
    host: env.PGHOST ?? '127.0.0.1',
    port: Number(env.PGPORT ?? 5433),
    user: env.PGUSER ?? 'viewer_ro',
    password: env.PGPASSWORD ?? 'viewer_ro',
    database: env.PGDATABASE ?? 'oblique',
    max: Number(env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    application_name: 'oblique-viewer-api',
  });
}
