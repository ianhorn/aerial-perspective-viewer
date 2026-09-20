import { expect, test } from '@playwright/test';
import { clickPlace, COVERED, drawnFootprint, openApp } from './support.ts';

// The app behind a proxy that serves it at a subpath (https://host/viewer/). The test server serves it at the root, so the
// requests for /viewer/... are sent on to the same path without /viewer. What matters is what the page asks for: every
// request must be under /viewer/, with none for /api/... or /assets/... at the root, which would miss behind such a proxy.

test('the app loads and works under a subpath, asking only for addresses under it', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1') asked.push(url.pathname);
  });
  await page.route('**/viewer/**', (route) => {
    const url = new URL(route.request().url());
    return route.continue({ url: `${url.origin}${url.pathname.replace(/^\/viewer/, '')}${url.search}` });
  });

  const outside = await openApp(page, { path: '/viewer/', photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(page.locator('#panel .frames .frame')).toHaveCount(5); // the lookup went through /viewer/api/frames
  await expect.poll(() => drawnFootprint(page)).not.toBe(''); // the map's worker loaded, or nothing would be drawn
  await expect(page.locator('#photo .photo-canvas')).toBeVisible(); // and a photo and its details came through /viewer/api/frames/...

  expect(asked.some((p) => p.startsWith('/viewer/api/frames'))).toBe(true);
  expect(asked.some((p) => p.startsWith('/viewer/assets/'))).toBe(true);
  expect(asked.filter((p) => !p.startsWith('/viewer/'))).toEqual([]); // nothing at the root
  expect(outside.errors).toEqual([]);
});

test('served at the root, as through the tunnel or in development, it asks for /api/... and /assets/...', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1') asked.push(url.pathname);
  });
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(page.locator('#panel .frames .frame')).toHaveCount(5);
  expect(asked.some((p) => p.startsWith('/api/frames'))).toBe(true);
  expect(asked.some((p) => p.startsWith('/assets/'))).toBe(true);
  expect(asked.filter((p) => p.startsWith('/viewer/'))).toEqual([]);
});
