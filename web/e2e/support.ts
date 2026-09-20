import { expect, type Page, type Route } from '@playwright/test';
import { API_PORT } from '../playwright.config.ts';
import { createCamera, type Camera, type Exterior, type Lens } from '../src/camera.ts';
import { fitSize, toPhoto, toScreen, type View } from '../src/zoom.ts';
import { buildPhoto, type FixturePhoto, rangeOf } from './fixture-photo.ts';

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
  /** Every request for a photo (or its terrain patch) the bucket was asked for: the address, and the Range asked. */
  photoRequests: { url: string; range: string | undefined }[];
}

export interface AppOptions {
  /** How the photo bucket answers every request when the photos are refused (default 403, so a photo cannot be read). */
  photoStatus?: number;
  /**
   * `refuse` (the default): the bucket refuses every request, so a photo cannot be read.
   * `fixture`: the bucket serves a made-up photo of the size the frame's sensor says (see fixture-photo.ts), and a flat
   * terrain patch at the synthetic data's ground height, so everything that needs a photo can be tested.
   */
  photos?: 'refuse' | 'fixture';
  /** The address of the page to open (default `/`). */
  path?: string;
}

/** The ground height of the synthetic data (pipeline/synthetic/generate.ts GROUND): flat, in feet. */
export const GROUND = 500;

const SENSOR_SIZE: Record<string, [number, number]> = {
  Fwd: [14144, 10560], Bwd: [14144, 10560], Left: [10560, 14144], Right: [10560, 14144], Color: [20544, 14016],
};
const photos = new Map<string, FixturePhoto>(); // one per size, made once in a worker

/** What the API says about a frame: the camera's data and the footprint (EPSG:3089 feet). */
export interface FrameData {
  filename: string;
  camera: string;
  eo: Exterior;
  sensor: Lens;
  footprint3089: number[][];
}
export async function frameData(filename: string): Promise<FrameData> {
  const response = await fetch(`http://127.0.0.1:${API_PORT}/api/frames/${filename}`);
  if (!response.ok) throw new Error(`the API answered ${response.status} for ${filename}`);
  return (await response.json()) as FrameData;
}

/** A flat terrain patch (the .json next to a photo) at GROUND, covering the frame's footprint with a margin. */
async function terrainPatch(filename: string): Promise<object> {
  const { footprint3089 } = await frameData(filename);
  const xs = footprint3089.map((p) => p[0]!), ys = footprint3089.map((p) => p[1]!);
  const cell = 50, margin = 400;
  const x0 = Math.floor((Math.min(...xs) - margin) / cell) * cell, y0 = Math.floor((Math.min(...ys) - margin) / cell) * cell;
  const cols = Math.ceil((Math.max(...xs) + margin - x0) / cell) + 1, rows = Math.ceil((Math.max(...ys) + margin - y0) / cell) + 1;
  return { cellSize: cell, lowerLeftX: x0, lowerLeftY: y0, minimumValue: GROUND, maximumValue: GROUND, noDataValue: -9999, value: Array.from({ length: rows }, () => new Array<number>(cols).fill(GROUND)) };
}

/**
 * Open the app with nothing outside this machine involved: the state's map tiles are blank, the photo bucket refuses
 * (the invented frames have no photos), and anything else is refused and reported in `strays`.
 */
export async function openApp(page: Page, options: AppOptions = {}): Promise<Outside> {
  const outside: Outside = { strays: [], errors: [], photoRequests: [] };
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
    } else if (url.hostname === 'images.e2e.test' && options.photos === 'fixture') {
      const range = route.request().headers()['range'];
      outside.photoRequests.push({ url: url.pathname, range });
      const name = decodeURIComponent(url.pathname.replace(/^\/obliques\//, ''));
      if (name.endsWith('.json')) {
        await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(await terrainPatch(name.replace(/\.json$/, '.tif'))) });
      } else {
        const camera = /\/(Fwd|Bwd|Left|Right|Color)_/.exec(name)?.[1] ?? 'Fwd';
        const [w, h] = SENSOR_SIZE[camera]!;
        const key = `${w}x${h}`;
        if (!photos.has(key)) photos.set(key, buildPhoto(w, h));
        const { status, headers, body } = rangeOf(photos.get(key)!.bytes, range);
        await route.fulfill({ status, headers: { ...CORS, ...headers, 'content-type': 'image/tiff' }, body });
      }
    } else if (url.hostname === 'images.e2e.test') {
      await route.fulfill({ status: options.photoStatus ?? 403, headers: CORS, body: '' });
    } else {
      outside.strays.push(url.origin + url.pathname);
      await route.abort();
    }
  });

  await page.goto(options.path ?? '/');
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

// --- geometry, for tests that click on a photo ---

/** Where the photo pane draws things: the canvas on the page, and the pane's own zoom state, from the canvas's data attributes. */
export interface PaneGeometry {
  box: { x: number; y: number; width: number; height: number };
  view: View;
  camera: Camera;
  /** A pixel of the full-size photo to a position on the page. */
  toPage(col: number, row: number): { x: number; y: number };
  /** A position on the page to a pixel of the full-size photo. */
  toPixel(x: number, y: number): { col: number; row: number };
}
export async function paneGeometry(page: Page, camera: Camera): Promise<PaneGeometry> {
  const canvas = page.locator('#photo .photo-canvas');
  const box = (await canvas.boundingBox())!;
  // The app sizes the stage by the canvas's whole-pixel client size, and reads its own zoom state; do the same.
  const data = await canvas.evaluate((c: HTMLCanvasElement) => ({ zoom: Number(c.dataset.zoom), cx: Number(c.dataset.cx), cy: Number(c.dataset.cy), w: c.clientWidth, h: c.clientHeight }));
  const view: View = { zoom: data.zoom, cx: data.cx, cy: data.cy };
  const stage = { w: data.w, h: data.h };
  const fit = fitSize(stage, camera.widthPx / camera.heightPx);
  return {
    box, view, camera,
    toPage: (col, row) => {
      const p = toScreen(view, { u: col / camera.widthPx, v: row / camera.heightPx }, stage, fit);
      return { x: box.x + p.x, y: box.y + p.y };
    },
    toPixel: (x, y) => {
      const p = toPhoto(view, { x: x - box.x, y: y - box.y }, stage, fit);
      return { col: p.u * camera.widthPx, row: p.v * camera.heightPx };
    },
  };
}

/** The frame the pane is showing: its API data and camera. */
export async function shownFrame(page: Page): Promise<FrameData & { cam: Camera }> {
  const name = (await page.locator('#photo .name').textContent())!.trim();
  const data = await frameData(name);
  return { ...data, cam: createCamera(data.eo, data.sensor) };
}

/**
 * Click the pane's photo where a ground point is seen, at whole page pixels, and say what ground that click really is
 * (worked out from the camera model and the flat ground, not from the app). Returns null if the point is not in the photo.
 */
export async function clickPaneAt(page: Page, frame: { cam: Camera }, at: { x: number; y: number; z: number }): Promise<{ x: number; y: number; ground: { x: number; y: number; z: number }; col: number; row: number } | null> {
  const pane = await paneGeometry(page, frame.cam);
  const pixel = frame.cam.groundToPixel(at.x, at.y, at.z);
  if (!pixel) return null;
  const spot = pane.toPage(pixel[0], pixel[1]);
  const x = Math.round(spot.x), y = Math.round(spot.y);
  const { col, row } = pane.toPixel(x, y);
  if (col < 0 || row < 0 || col > frame.cam.widthPx || row > frame.cam.heightPx) return null;
  await page.mouse.click(x, y);
  const ground = groundAtPixel(frame.cam, col, row);
  return { x, y, ground, col, row };
}

/** The number at the start of a readout value like "123.4 ft (37.6 m)". */
export const leadingNumber = (text: string): number => Number(/^[+−-]?[\d,]+(\.\d+)?/.exec(text.replace('−', '-'))![0].replace(/,/g, ''));

/** The readout of the measuring tools in the pane, as label: value. */
export async function paneReadout(page: Page): Promise<Record<string, string>> {
  const terms = await page.locator('#photo .measure-readout dt').allTextContents();
  const values = await page.locator('#photo .measure-readout dd').allTextContents();
  return Object.fromEntries(terms.map((t, i) => [t, values[i]!]));
}

// --- expected values that do not use the code under test ---
// Worked out from the camera model alone (which has its own unit tests) and plain geometry, so a bug in the app's
// measuring code cannot make the expected value wrong in the same way.

/** The ground point a pixel sees on the flat ground: where the ray meets the plane at GROUND. */
export function groundAtPixel(cam: Camera, col: number, row: number): { x: number; y: number; z: number } {
  const hit = cam.pixelToGround(col, row, GROUND);
  if (!hit) throw new Error('the ray does not reach the ground');
  return { x: hit[0], y: hit[1], z: GROUND };
}

/** How high above `base` the point seen at a pixel is, found by searching for the height whose picture position is nearest the pixel. */
export function heightSeenAt(cam: Camera, base: { x: number; y: number; z: number }, col: number, row: number): number {
  const miss = (h: number): number => {
    const p = cam.groundToPixel(base.x, base.y, base.z + h);
    return p ? Math.hypot(p[0] - col, p[1] - row) : Infinity;
  };
  let lo = -200, hi = 800; // the distance to the pixel is smallest at one height along the line: search by golden sections
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = hi - phi * (hi - lo), b = lo + phi * (hi - lo);
  for (let i = 0; i < 80; i++) {
    if (miss(a) < miss(b)) hi = b; else lo = a;
    a = hi - phi * (hi - lo);
    b = lo + phi * (hi - lo);
  }
  return (lo + hi) / 2;
}

export const lengthBetween = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(b.x - a.x, b.y - a.y);

/** The shoelace formula, written out here. */
export function areaOf(points: readonly { x: number; y: number }[]): number {
  let twice = 0;
  points.forEach((p, i) => { const q = points[(i + 1) % points.length]!; twice += p.x * q.y - q.x * p.y; });
  return Math.abs(twice) / 2;
}

/** Whether any pixel of the pane's canvas within `radius` of a page position satisfies `test` (red, green, blue). */
export async function paneHasPixel(page: Page, at: { x: number; y: number }, radius: number, test: (r: number, g: number, b: number) => boolean): Promise<boolean> {
  return page.locator('#photo .photo-canvas').evaluate((c: HTMLCanvasElement, [px, py, rad, source]) => {
    const t = new Function('r', 'g', 'b', `return (${source as string})(r, g, b)`) as (r: number, g: number, b: number) => boolean;
    const box = c.getBoundingClientRect();
    const x = Math.round(px as number - box.left) - (rad as number), y = Math.round(py as number - box.top) - (rad as number);
    const size = 2 * (rad as number) + 1;
    const data = c.getContext('2d')!.getImageData(Math.max(0, x), Math.max(0, y), size, size).data;
    for (let i = 0; i < data.length; i += 4) if (t(data[i]!, data[i + 1]!, data[i + 2]!)) return true;
    return false;
  }, [at.x, at.y, radius, test.toString()] as const);
}
export const isGreen = (r: number, g: number, b: number): boolean => Math.abs(r - 102) < 24 && Math.abs(g - 187) < 24 && Math.abs(b - 106) < 24; // the plumb colour
export const isAmber = (r: number, g: number, b: number): boolean => r > 240 && Math.abs(g - 179) < 14 && b < 30;
export const isWhite = (r: number, g: number, b: number): boolean => r > 235 && g > 235 && b > 235;
