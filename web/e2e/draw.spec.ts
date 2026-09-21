import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import initSqlJs from 'sql.js';
import { STORAGE_KEY } from '../src/draw-storage.ts';
import { clickPlace, COVERED, openApp, showPlace, DRAW_BAR } from './support.ts';

// The drawing tools, in the real app. What is checked is what a person sees and gets: shapes on the map (asked of the rendered
// layers, since a source can hold data the map never draws), the numbers on the card, the file that comes out, and that the
// drawing survives a reload. The sizes are checked against the map's own scale, not against the app's own arithmetic.

interface Saved { id: string; kind: string; coordinates: [number, number][]; radiusM?: number; properties: { label: string; notes: string; color: string } }

/** Open the app at a place, the drawing area (right of the results panel and the drawing card) free. */
async function open(page: Page): Promise<{ at: (x: number, y: number) => { x: number; y: number } }> {
  await openApp(page);
  await showPlace(page, COVERED, 12);
  const box = (await page.locator('#map canvas').boundingBox())!;
  return { at: (x, y) => ({ x: box.x + x, y: box.y + y }) };
}
const tool = (page: Page, name: string) => page.getByRole('group', { name: 'Drawing tools' }).getByRole('button', { name, exact: true });
async function draw(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(page.locator(DRAW_BAR)).toBeVisible();
}
/** The drawing as saved in the browser (after the short wait before it is saved). */
async function saved(page: Page, count: number): Promise<Saved[]> {
  await expect.poll(async () => (await read(page)).length, { message: 'the drawing is saved in the browser' }).toBe(count);
  return read(page);
}
const read = (page: Page): Promise<Saved[]> =>
  page.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? '{"features":[]}') as { features: Saved[] }).features, STORAGE_KEY);
/** Metres a screen pixel covers at the map's zoom and latitude (Web Mercator, 512 px tiles at MapLibre's zoom 0): the map's own scale. */
const metresPerPixel = (page: Page): Promise<number> =>
  page.evaluate(() => { const m = window.__map!; return (40075016.686 * Math.cos((m.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** m.getZoom()); });
/** The area in square metres of a ring of lon/lat, on a local flat approximation (good to 0.1% for a few hundred metres). */
const flatArea = (ring: [number, number][]): number => {
  const lat0 = (ring[0]![1] * Math.PI) / 180, R = 6371008.8;
  const pts = ring.map(([lon, lat]) => [((lon - ring[0]![0]) * Math.PI / 180) * R * Math.cos(lat0), ((lat - ring[0]![1]) * Math.PI / 180) * R]);
  let twice = 0;
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]!; twice += p[0]! * q[1]! - q[0]! * p[1]!; });
  return Math.abs(twice) / 2;
};
/** What the map is really drawing from the drawing layers, by feature id. */
const drawnIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...new Set(window.__map!.queryRenderedFeatures({ layers: ['draw-line', 'draw-point', 'draw-fill'] }).map((f) => String(f.properties['id'])))]);

test('the Draw button opens the tools, and Escape backs out one step at a time', async ({ page }) => {
  await open(page);
  const bar = page.locator(DRAW_BAR);
  await expect(bar).toBeHidden();
  await draw(page);
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['Point', 'Line', 'Polygon', 'Rectangle', 'Circle', 'Text']) await expect(tool(page, name)).toBeVisible();
  await tool(page, 'Line').click();
  await expect(tool(page, 'Line')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.draw-prompt')).toContainText('first point');
  await page.keyboard.press('Escape'); // from a drawing tool back to Select
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(bar).toBeHidden();
});

test('a line: points are clicked, a double-click finishes it, and the card gives its length', async ({ page }) => {
  const { at } = await open(page);
  await draw(page);
  await tool(page, 'Line').click();
  const zoom = await page.evaluate(() => window.__map!.getZoom());
  const a = at(800, 400), b = at(1000, 400), c = at(1000, 550);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.mouse.move(c.x, c.y);
  await page.mouse.dblclick(c.x, c.y);
  const [line] = await saved(page, 1);
  expect(line!.kind).toBe('line');
  expect(line!.coordinates).toHaveLength(3); // the double-click did not add a fourth
  await page.waitForTimeout(600); // a double-click zoom, if the map still did one, would be under way by now
  expect(await page.evaluate(() => window.__map!.getZoom())).toBe(zoom);
  // 200 px + 150 px on the screen, in the map's own scale
  const mpp = await metresPerPixel(page);
  const lengthFt = (350 * mpp) / 0.3048006096;
  const shown = await page.locator('.draw-sizes dd').first().innerText();
  const shownFt = Number(/^([\d,.]+) ft/.exec(shown)![1]!.replace(/,/g, ''));
  expect(Math.abs(shownFt - lengthFt) / lengthFt).toBeLessThan(0.005); // the grid and the map's scale differ by about 0.1%
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true'); // done: back on Select, the line selected
  await expect(page.locator('.draw-editor-heading')).toHaveText('Line');
  expect(await drawnIds(page)).toContain(line!.id); // and the map really draws it
});

test('a rectangle, a circle and a polygon come out at the size drawn on the screen', async ({ page }) => {
  const { at } = await open(page);
  await draw(page);
  const mpp = await metresPerPixel(page);

  await tool(page, 'Rectangle').click();
  await page.mouse.click(at(800, 300).x, at(800, 300).y);
  await page.mouse.click(at(1000, 400).x, at(1000, 400).y); // 200 x 100 px
  await tool(page, 'Circle').click();
  await page.mouse.click(at(900, 600).x, at(900, 600).y);
  await page.mouse.click(at(960, 600).x, at(960, 600).y); // radius 60 px
  await tool(page, 'Polygon').click();
  for (const [x, y] of [[1100, 450], [1250, 450], [1250, 550]] as const) await page.mouse.click(at(x, y).x, at(x, y).y); // a right triangle, legs 150 and 100 px
  await page.keyboard.press('Enter');

  const [rectangle, circle, polygon] = await saved(page, 3);
  expect([rectangle!.kind, circle!.kind, polygon!.kind]).toEqual(['rectangle', 'circle', 'polygon']);
  const near = (got: number, expected: number, tolerance: number) => expect(Math.abs(got - expected) / expected).toBeLessThan(tolerance);
  near(flatArea(rectangle!.coordinates), 200 * mpp * 100 * mpp, 0.01);
  near(circle!.radiusM!, 60 * mpp, 0.01);
  near(flatArea(polygon!.coordinates), 0.5 * 150 * mpp * 100 * mpp, 0.01);
  // The card shows the area of the polygon that is selected now, in acres too.
  await expect(page.locator('.draw-sizes')).toContainText('acres');
  expect(await drawnIds(page)).toEqual(expect.arrayContaining([rectangle!.id, circle!.id, polygon!.id]));
});

test('text: placed, typed straight into, shown on the map, and still there after a reload', async ({ page }) => {
  const { at } = await open(page);
  await draw(page);
  await tool(page, 'Text').click();
  await page.mouse.click(at(900, 450).x, at(900, 450).y);
  const label = page.getByRole('textbox', { name: 'Label' });
  await expect(label).toBeFocused(); // no need to click into it
  await page.keyboard.type('Well 4'); // replaces the starting word, which was selected
  await page.keyboard.press('Enter');
  await expect(page.locator('.draw-label', { hasText: 'Well 4' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Notes' }).fill('checked in May');
  await page.getByRole('textbox', { name: 'Notes' }).blur();
  await page.getByRole('radio', { name: '#1e88e5' }).click();
  const [text] = await saved(page, 1);
  await expect.poll(async () => (await read(page))[0]!.properties.color).toBe('#1e88e5');
  expect(text!.kind).toBe('text');
  await expect.poll(async () => (await read(page))[0]!.properties).toMatchObject({ label: 'Well 4', notes: 'checked in May', color: '#1e88e5' });
  await expect(page.locator('.draw-label', { hasText: 'Well 4' })).toHaveCSS('color', 'rgb(30, 136, 229)');

  await page.reload();
  await page.waitForFunction(() => window.__map?.getLayer('draw-line') !== undefined);
  await expect(page.locator('.draw-label', { hasText: 'Well 4' })).toBeVisible();
  await expect(page.locator(DRAW_BAR)).toBeHidden(); // the tools are off again; the drawing is not
});

test('select, move a corner, delete, undo and redo', async ({ page }) => {
  const { at } = await open(page);
  await draw(page);
  await tool(page, 'Polygon').click();
  for (const [x, y] of [[800, 400], [1000, 400], [1000, 550], [800, 550]] as const) await page.mouse.click(at(x, y).x, at(x, y).y);
  await page.keyboard.press('Enter');
  const [before] = await saved(page, 1);
  const centre = await page.evaluate(() => { const c = window.__map!.getCenter(); return [c.lng, c.lat]; });

  // drag the corner at (1000, 550) up and right; the map must not pan under the drag
  await page.mouse.move(at(1000, 550).x, at(1000, 550).y);
  await page.mouse.down();
  await page.mouse.move(at(1040, 520).x, at(1040, 520).y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await read(page))[0]!.coordinates[2]![0]).not.toBe(before!.coordinates[2]![0]);
  const [after] = await read(page);
  expect(after!.coordinates[0]).toEqual(before!.coordinates[0]); // the other corners stayed
  expect(after!.coordinates[1]).toEqual(before!.coordinates[1]);
  const mpp = await metresPerPixel(page);
  const moved = { east: (after!.coordinates[2]![0] - before!.coordinates[2]![0]) * 111319.49 * Math.cos((38.23 * Math.PI) / 180) / mpp };
  expect(moved.east).toBeGreaterThan(38);
  expect(moved.east).toBeLessThan(42); // 40 px to the right
  expect(await page.evaluate(() => { const c = window.__map!.getCenter(); return [c.lng, c.lat]; })).toEqual(centre);

  await page.getByRole('button', { name: 'Undo', exact: true }).click(); // one step puts the whole drag back
  await expect.poll(async () => (await read(page))[0]!.coordinates[2]).toEqual(before!.coordinates[2]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await read(page))[0]!.coordinates[2]).toEqual(after!.coordinates[2]);

  await page.keyboard.press('Delete');
  await saved(page, 0);
  await page.keyboard.press('Control+z');
  await saved(page, 1);
});

test('the file that is exported holds what was drawn', async ({ page }) => {
  const { at } = await open(page);
  await draw(page);
  await tool(page, 'Point').click();
  await page.mouse.click(at(850, 350).x, at(850, 350).y);
  await page.getByRole('textbox', { name: 'Label' }).fill('Gate');
  await page.getByRole('textbox', { name: 'Label' }).press('Enter');
  await tool(page, 'Circle').click();
  await page.mouse.click(at(1000, 550).x, at(1000, 550).y);
  await page.mouse.click(at(1050, 550).x, at(1050, 550).y);
  const [point, circle] = await saved(page, 2);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GeoJSON', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^drawing-\d{8}-\d{6}\.geojson$/);
  const json = JSON.parse(await readFile((await file.path())!, 'utf8')) as {
    type: string; features: { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[];
  };
  expect(json.type).toBe('FeatureCollection');
  expect(json.features.map((f) => f.geometry.type)).toEqual(['Point', 'Polygon']);
  expect(json.features[0]!.geometry.coordinates).toEqual(point!.coordinates[0]);
  expect(json.features[0]!.properties).toMatchObject({ kind: 'point', label: 'Gate' });
  expect(json.features[1]!.properties).toMatchObject({ kind: 'circle', radius_m: circle!.radiusM });
  const ring = json.features[1]!.geometry.coordinates as [number, number][][];
  expect(ring[0]![0]).toEqual(ring[0]!.at(-1)); // closed
});

test('GeoPackage and GeoParquet files come out of the browser (which loads their libraries on the spot), in the coordinate system chosen', async ({ page }) => {
  const { at } = await open(page);
  await draw(page);
  await tool(page, 'Point').click();
  await page.mouse.click(at(850, 350).x, at(850, 350).y);
  await tool(page, 'Line').click();
  await page.mouse.click(at(900, 450).x, at(900, 450).y);
  await page.mouse.dblclick(at(1100, 500).x, at(1100, 500).y);
  await tool(page, 'Circle').click();
  await page.mouse.click(at(1000, 650).x, at(1000, 650).y);
  await page.mouse.click(at(1060, 650).x, at(1060, 650).y);
  const [point, , circle] = await saved(page, 3);

  // the libraries are not loaded until they are needed
  const loaded = (): Promise<string[]> => page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /sql-wasm|draw-gpkg|draw-parquet/.test(n)));
  expect(await loaded()).toEqual([]);

  await page.getByRole('combobox', { name: /Coordinate system/ }).selectOption('stateplane');
  const gpkgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GeoPackage', exact: true }).click();
  const gpkg = await gpkgDownload;
  expect(gpkg.suggestedFilename()).toMatch(/^drawing-\d{8}-\d{6}\.gpkg$/);
  const SQL = await initSqlJs();
  const db = new SQL.Database(await readFile((await gpkg.path())!));
  const rows = (sql: string): unknown[][] => db.exec(sql)[0]?.values ?? [];
  expect((await loaded()).some((n) => n.endsWith('.wasm'))).toBe(true); // the SQLite engine was fetched for it
  expect(rows('PRAGMA application_id')).toEqual([[0x47504b47]]);
  expect(rows('SELECT table_name, srs_id FROM gpkg_contents ORDER BY table_name')).toEqual([['lines', 3089], ['points', 3089], ['polygons', 3089]]);
  expect(rows('SELECT id, kind FROM points')).toEqual([[point!.id, 'point']]);
  // State Plane feet: the point's easting is in the millions (WGS84 degrees would be about -85)
  const [x] = rows('SELECT min_x FROM gpkg_contents WHERE table_name = \'points\'')[0] as [number];
  expect(x).toBeGreaterThan(4_000_000);

  // a second export does not start the engine again
  const again = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GeoPackage', exact: true }).click();
  await again;
  expect((await loaded()).filter((n) => n.endsWith('.wasm'))).toHaveLength(1);

  const parquetDownload = page.waitForEvent('download');
  await page.getByRole('combobox', { name: /Coordinate system/ }).selectOption('wgs84');
  await page.getByRole('button', { name: 'GeoParquet', exact: true }).click();
  const parquet = await parquetDownload;
  expect(parquet.suggestedFilename()).toMatch(/^drawing-\d{8}-\d{6}\.parquet$/);
  const bytes = await readFile((await parquet.path())!);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const table = await parquetReadObjects({ file: buffer });
  expect(table.map((r) => r['kind'])).toEqual(['point', 'line', 'circle']);
  expect(table[0]!['geometry']).toEqual({ type: 'Point', coordinates: point!.coordinates[0] });
  expect(table[2]!['radius_m']).toBe(circle!.radiusM);
  const geo = JSON.parse(parquetMetadata(buffer).key_value_metadata!.find((kv) => kv.key === 'geo')!.value!) as { columns: { geometry: { crs?: unknown } } };
  expect('crs' in geo.columns.geometry).toBe(false); // WGS84: the default
});

test('clicks draw instead of looking up photos while the tools are on, and look up again when they are off', async ({ page }) => {
  const { at } = await open(page);
  await draw(page);
  await tool(page, 'Point').click();
  const spot = at(900, 450);
  await page.mouse.click(spot.x, spot.y);
  await saved(page, 1);
  await expect(page.locator('#panel .status')).toHaveCount(0); // no lookup was made: the panel still shows its first prompt
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('#panel .status')).toHaveText(/photos cover this point|No photos cover|did not answer/);
});

test('the tools are not offered in a scene, and come back when it is turned off', async ({ page }) => {
  await open(page);
  await draw(page);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  const button = page.getByRole('button', { name: 'Draw', exact: true });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /plain map/);
  await expect(page.locator(DRAW_BAR)).toBeHidden();
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await expect(button).toBeEnabled();
});

test('Escape cancels a shape being drawn without closing the photo pane', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  const pane = page.locator('#photo');
  await expect(pane).toBeVisible();
  await draw(page);
  await tool(page, 'Line').click();
  const box = (await page.locator('#map canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 250, box.y + 700);
  await page.mouse.click(box.x + box.width - 150, box.y + 700);
  await expect(page.locator('.draw-prompt')).toContainText('Click to add points');
  await page.keyboard.press('Escape'); // the shape
  await page.keyboard.press('Escape'); // the tool
  await expect(pane).toBeVisible();
  await expect(page.locator('.draw-prompt')).toContainText('Click a shape');
});

test('a browser that will not keep the drawing still draws', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  const outside = await openApp(page);
  await showPlace(page, COVERED, 12);
  await draw(page);
  await tool(page, 'Point').click();
  const box = (await page.locator('#map canvas').boundingBox())!;
  await page.mouse.click(box.x + 900, box.y + 450);
  await expect(page.locator('.draw-count')).toHaveText('1 feature');
  expect(outside.errors).toEqual([]);
});
