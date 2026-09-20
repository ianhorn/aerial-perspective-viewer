import { defineConfig } from '@playwright/test';

// Browser tests: the real app (a production build) in headless Chromium, against the real API and a real PostGIS
// database holding the small invented dataset (pipeline/synthetic), so they need none of the vendor's data.
// Everything outside this machine (the state's map tiles, the photo bucket) is answered by the tests themselves
// (e2e/support.ts), so they need no network.
//
// The database comes from the usual PG* variables, as for the API (api/src/db.ts): PGHOST, PGPORT, PGUSER,
// PGPASSWORD, PGDATABASE, as the read-only role viewer_ro. Load it first with pipeline/synthetic/load.sh.
// The servers use their own ports, so a development server on 5173 and 3001 is neither used nor disturbed,
// and it is never reused: a test must not run against the real database by accident.
//
//   npm run test:e2e
//   PGPORT=5544 PGDATABASE=oblique_test npm run test:e2e   (a scratch database on another port)

const API_PORT = 3101;
const WEB_PORT = 4273;
export const IMAGE_BASE = 'https://images.e2e.test/obliques/'; // an address that cannot exist, answered in e2e/support.ts

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node ../api/src/server.ts',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: { HOST: '127.0.0.1', PORT: String(API_PORT), IMAGE_BASE },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // VITE_EXPOSE_MAP puts the map on `window.__map`, so a test can ask what is drawn. Typechecking is a separate step.
      command: `vite build --outDir dist/e2e && vite preview --outDir dist/e2e --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}/`,
      // VITE_TITILER_URL is emptied so the build never picks up an address from a local, git-ignored .env.local.
      env: { VITE_EXPOSE_MAP: '1', VITE_TITILER_URL: '', API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
