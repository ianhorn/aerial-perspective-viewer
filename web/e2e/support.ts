import { expect, type Page, type Route } from '@playwright/test';

// The invented dataset (pipeline/synthetic/generate.ts) is ten north-south flight lines over central Kentucky, at
// EPSG:3089 (4,905,000 to 4,914,000 ft east, 3,950,000 to 3,992,000 ft north). This is its middle, in lon/lat, worked
// out with web/src/lcc.ts. Every direction is photographed there.
export const COVERED: [number, number] = [-85.78777, 38.22878];
// A place in Kentucky (near Paducah) that the invented data does not reach.
export const UNCOVERED: [number, number] = [-88.6, 37.08];

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
// A 1 × 1 transparent PNG, for every map tile.
const BLANK_TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export interface Outside {
  /** The requests that left the app for anywhere but the app itself and the two hosts answered below. Should stay empty. */
  strays: string[];
  /** The console errors and uncaught exceptions the page produced. */
  errors: string[];
}

export interface AppOptions {
  /** How the photo bucket answers every request (default 403, so a photo cannot be read). */
  photoStatus?: number;
}

/**
 * Open the app with nothing outside this machine involved: the state's map tiles are blank, the photo bucket refuses
 * (the invented frames have no photos), and anything else is refused and reported in `strays`.
 */
export async function openApp(page: Page, options: AppOptions = {}): Promise<Outside> {
  const outside: Outside = { strays: [], errors: [] };
  page.on('pageerror', (error) => outside.errors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    // The photos are refused on purpose (the invented frames have none), and the app and the browser both log that.
    if (message.type() === 'error' && !/Failed to load resource|images\.e2e\.test/.test(message.text())) outside.errors.push(message.text());
  });

  const preflight = (route: Route): boolean => {
    if (route.request().method() !== 'OPTIONS') return false;
    void route.fulfill({ status: 204, headers: CORS });
    return true;
  };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const url = new URL(route.request().url());
    if (preflight(route)) return;
    if (url.hostname === 'kygisserver.ky.gov') {
      await route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: BLANK_TILE });
    } else if (url.hostname === 'images.e2e.test') {
      await route.fulfill({ status: options.photoStatus ?? 403, headers: CORS, body: '' });
    } else {
      outside.strays.push(url.origin + url.pathname);
      await route.abort();
    }
  });

  await page.goto('/');
  // The map's own layers are added when it has loaded. (A lost MapLibre worker does not stop that: the layers are added
  // but never receive data, which only shows once a footprint has to be drawn. The lookup tests check that.)
  await page.waitForFunction(() => window.__map?.getLayer('frame-fill') !== undefined);
  return outside;
}

/** Centre the map on a place at a zoom where a photo's footprint is a few hundred pixels across, clear of the panel. */
export async function showPlace(page: Page, place: [number, number], zoom = 12): Promise<{ x: number; y: number }> {
  return page.evaluate(([lngLat, z]) => {
    const map = window.__map!;
    map.jumpTo({ center: lngLat, zoom: z, padding: { left: 420 } }); // the results panel covers the left of the map
    return map.project(lngLat);
  }, [place, zoom] as const);
}

/** Click a place on the map, and wait for the list of photos (or the message that there are none). */
export async function clickPlace(page: Page, place: [number, number], zoom = 12): Promise<void> {
  const at = await showPlace(page, place, zoom);
  const box = (await page.locator('#map canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await expect(page.locator('#panel .status')).toHaveText(/photos cover this point|No photos cover|did not answer/);
}

/** The footprint drawn on the map right now, as an ordered string that changes when it does, or '' when there is none. */
export async function drawnFootprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const features = window.__map!.queryRenderedFeatures(undefined, { layers: ['frame-fill'] });
    return features.map((feature) => JSON.stringify(feature.geometry)).sort().join('|'); // a polygon may come in pieces
  });
}

/** Where a place is on the map's canvas right now. The map narrows when the photo pane opens, so this moves. */
export async function pixelOf(page: Page, place: [number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate((lngLat) => window.__map!.project(lngLat), place);
}
