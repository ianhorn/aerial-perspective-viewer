import { buildApp } from './app.ts';
import { createPool } from './db.ts';

// Configuration comes from the environment. The database variables are in db.ts.
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3001);
const imageBase = process.env.IMAGE_BASE ?? 'https://kyfromabove.s3.us-west-2.amazonaws.com/imagery/obliques/Phase3/';
const cacheSeconds = Number(process.env.CACHE_SECONDS ?? 300);

const pool = createPool();
const app = buildApp({ pool, imageBase, cacheSeconds, logger: true });

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
