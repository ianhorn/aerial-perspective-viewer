import { expect, test, type Page } from '@playwright/test';
import { COVERED, openApp } from './support.ts';

// The search box, end to end: type a place, an address or coordinates, press Enter, and the map goes there, the pin drops and the
// photos are listed, as if the map had been clicked at that spot. Coordinates are read in the browser; names go to the geocoder,
// which the test answers itself (support.ts) with results near the covered point, so the whole flow can be followed.

const box = (page: Page) => page.getByRole('searchbox', { name: /Search for a place/ });
const search = async (page: Page, text: string): Promise<void> => {
  await box(page).fill(text);
  await box(page).press('Enter');
};
const selected = async (page: Page): Promise<[number, number]> => {
  const [lat, lng] = (await page.locator('#panel .coords').textContent())!.split(', ').map(Number);
  return [lng!, lat!];
};
/** Whether a place is on the visible part of the map: on the canvas and not under the panel. */
const shown = (page: Page, [lon, lat]: [number, number]) => page.evaluate(([lo, la]) => {
  const p = window.__map!.project([lo!, la!]);
  const width = window.__map!.getCanvas().clientWidth, height = window.__map!.getCanvas().clientHeight;
  const panel = document.getElementById('panel')!.getBoundingClientRect();
  return p.x > panel.right && p.x < width && p.y > 0 && p.y < height;
}, [lon, lat] as const);

test('the box is at the top of the panel, with a button, and says what it takes', async ({ page }) => {
  await openApp(page);
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toHaveAttribute('placeholder', 'Place, address or coordinates');
  await expect(page.locator('#panel .search').getByRole('button', { name: 'Search' })).toBeVisible();
  // it comes before the prompt to click the map
  const order = await page.evaluate(() => [...document.querySelectorAll('#panel > *')].map((e) => e.className || e.tagName.toLowerCase()));
  expect(order.indexOf('search')).toBeGreaterThan(-1);
  expect(order.indexOf('search')).toBeLessThan(order.indexOf('where'));
});

test('coordinates go straight there: the map moves, the pin drops and the photos are listed, with no lookup by name', async ({ page }) => {
  const outside = await openApp(page, { photos: 'fixture' });
  await search(page, `${COVERED[1]}, ${COVERED[0]}`);
  await expect(page.locator('#panel .search-status')).toHaveText(`Going to ${COVERED[1].toFixed(5)}, ${COVERED[0].toFixed(5)}.`);
  await expect(page.locator('#panel .frames .frame')).toHaveCount(5);
  const [lng, lat] = await selected(page);
  expect(Math.abs(lng - COVERED[0])).toBeLessThan(1e-4);
  expect(Math.abs(lat - COVERED[1])).toBeLessThan(1e-4);
  await expect(page.locator('.maplibregl-marker')).toHaveCount(1);
  await expect.poll(() => shown(page, COVERED)).toBe(true); // in view, on the part of the map the panel does not cover
  await expect.poll(() => page.evaluate(() => window.__map!.getZoom())).toBeGreaterThanOrEqual(16.9); // at street level, where the photos are best
  expect(outside.searches).toEqual([]); // nothing was sent to the search service
});

test('degrees-minutes-seconds and State Plane coordinates land on the same place', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  const dms = (v: number, pos: string, neg: string) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60; return `${d}°${m}'${s.toFixed(3)}"${v < 0 ? neg : pos}`; };
  await search(page, `${dms(COVERED[1], 'N', 'S')} ${dms(COVERED[0], 'E', 'W')}`);
  await expect(page.locator('#panel .frames .frame')).toHaveCount(5);
  let [lng, lat] = await selected(page);
  expect(Math.abs(lng - COVERED[0])).toBeLessThan(2e-5);
  expect(Math.abs(lat - COVERED[1])).toBeLessThan(2e-5);

  const { lonLatToGrid } = await import('../src/lcc.ts');
  const [x, y] = lonLatToGrid(COVERED[0] + 0.001, COVERED[1] + 0.001);
  await search(page, `${Math.round(x).toLocaleString('en-US')} E, ${Math.round(y).toLocaleString('en-US')} N`);
  await expect.poll(async () => (await selected(page))[0]).toBeGreaterThan(COVERED[0] + 0.0005); // the pin moved to the State Plane point
  [lng, lat] = await selected(page);
  expect(Math.abs(lng - (COVERED[0] + 0.001))).toBeLessThan(1e-4);
  expect(Math.abs(lat - (COVERED[1] + 0.001))).toBeLessThan(1e-4);
});

test('a place with one answer is gone to at once, and the search asked only for Kentucky\'s area', async ({ page }) => {
  const outside = await openApp(page, { photos: 'fixture' });
  await search(page, 'covered building');
  await expect(page.locator('#panel .frames .frame')).toHaveCount(5);
  const [lng, lat] = await selected(page);
  expect(Math.abs(lng - COVERED[0])).toBeLessThan(1e-4);
  expect(Math.abs(lat - COVERED[1])).toBeLessThan(1e-4);
  await expect(page.locator('#panel .search-results')).toBeHidden();
  expect(outside.searches).toHaveLength(1);
  expect(outside.searches[0]).toMatchObject({ q: 'covered building', bounded: '1' });
  const [west, north, east, south] = outside.searches[0]!.viewbox!.split(',').map(Number);
  expect(west! < -89.7 && east! > -81.9 && south! < 36.5 && north! > 39.1).toBe(true);
});

test('several answers are listed with what each is and where, and choosing one goes there', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await search(page, 'two places');
  const items = page.locator('#panel .search-results .search-result');
  await expect(items).toHaveCount(2);
  await expect(page.locator('#panel .search-status')).toHaveText('2 places found. Choose one.');
  await expect(items.first().locator('strong')).toHaveText('Two Alpha Place');
  await expect(items.first().locator('span')).toHaveText('Building · 1 Alpha Street, Louisville, Jefferson County, KY');
  await expect(page.locator('#panel .search-credit a')).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');

  await items.nth(1).click();
  await expect(page.locator('#panel .search-results')).toBeHidden();
  await expect.poll(async () => (await selected(page))[0]).toBeGreaterThan(COVERED[0] + 0.004); // the second answer, east of the first
  expect(Math.abs((await selected(page))[1] - (COVERED[1] + 0.002))).toBeLessThan(1e-4);
});

test('a town is shown whole and its middle looked up; a county is shown whole with no pin', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await search(page, 'the town');
  await expect(page.locator('#panel .frames .frame')).toHaveCount(5);
  await expect.poll(() => page.evaluate(() => window.__map!.getZoom())).toBeLessThan(16); // the whole town is in view, not one building
  await expect.poll(() => shown(page, COVERED)).toBe(true);

  // A county is 0.6 degrees across: fitted on the map, and no photo lookup or pin for its middle
  await page.reload();
  await page.waitForFunction(() => window.__map?.getLayer('frame-fill') !== undefined);
  await search(page, 'the county');
  await expect.poll(() => page.evaluate(() => window.__map!.getZoom())).toBeLessThan(11);
  await expect(page.locator('.maplibregl-marker')).toHaveCount(0);
  await expect(page.locator('#panel .where')).toHaveText('Click the map to pick a location.');
});

test('nothing found, a busy service and a service that fails each say so, with what to try', async ({ page }) => {
  await openApp(page);
  await search(page, 'nothing here');
  await expect(page.locator('#panel .search-status')).toContainText('Nothing found for “nothing here”');
  await expect(page.locator('#panel .search-status')).toContainText('ZIP code');
  await expect(page.locator('#panel .search-status')).toContainText('coordinates');

  await expect(page.locator('#panel .search-status')).not.toContainText('Intersections'); // only said when two streets were asked for
  await search(page, 'nothing at 4th & main');
  await expect(page.locator('#panel .search-status')).toContainText('Intersections cannot be searched.');

  await search(page, 'busy place');
  await expect(page.locator('#panel .search-status')).toHaveText('The search service is busy. Try again in a moment.');
  await search(page, 'broken place');
  await expect(page.locator('#panel .search-status')).toHaveText('The search service did not answer. Try again in a moment.');
  await expect(page.locator('#panel .search-go')).toBeEnabled(); // and it can be tried again
  await expect(page.locator('#panel .where')).toHaveText('Click the map to pick a location.'); // none of them moved the pin
});

test('coordinates outside the area the viewer covers are refused, and the map stays where it was', async ({ page }) => {
  const outside = await openApp(page);
  const before = await page.evaluate(() => window.__map!.getCenter().toArray());
  await search(page, '48.1, -100.2');
  await expect(page.locator('#panel .search-status')).toHaveText('That place is outside the area this viewer covers (Kentucky and a margin around it).');
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__map!.getCenter().toArray())).toEqual(before);
  await expect(page.locator('.maplibregl-marker')).toHaveCount(0);
  expect(outside.searches).toEqual([]);
});

test('what was typed stays in the box across a lookup and a change of direction, and Escape clears the answers without closing the pane', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await search(page, 'two places');
  await expect(page.locator('#panel .search-results .search-result')).toHaveCount(2);
  await page.locator('#panel .search-results .search-result').first().click();
  await expect(page.locator('#panel .frames .frame')).toHaveCount(5);
  await expect(box(page)).toHaveValue('two places'); // the panel was redrawn for the lookup; the box was kept
  await page.getByRole('button', { name: 'East', exact: true }).click();
  await expect(box(page)).toHaveValue('two places');

  await search(page, 'two places again'); // several answers again
  await expect(page.locator('#panel .search-results')).toBeVisible();
  await box(page).press('Escape');
  await expect(page.locator('#panel .search-results')).toBeHidden();
  await expect(page.locator('#photo')).toBeVisible(); // Escape was used up by the search box
});

test('the same search is asked once, and different ones are kept about a second apart', async ({ page }) => {
  const outside = await openApp(page);
  await search(page, 'nothing one');
  await expect(page.locator('#panel .search-status')).toContainText('Nothing found');
  await search(page, 'nothing one'); // remembered: no second request
  await search(page, 'nothing two');
  await expect(page.locator('#panel .search-status')).toContainText('“nothing two”', { timeout: 15_000 });
  expect(outside.searches.map((s) => s.q)).toEqual(['nothing one', 'nothing two']);
  expect(outside.searches[1]!.at - outside.searches[0]!.at).toBeGreaterThanOrEqual(1000); // the service asks for one a second at most
});

test('the map\'s credit names OpenStreetMap, as the search data requires', async ({ page }) => {
  await openApp(page);
  const credit = await page.locator('.maplibregl-ctrl-attrib').innerHTML();
  expect(credit).toContain('© OpenStreetMap contributors');
  expect(credit).toContain('Kentucky Division of Geographic Information'); // the state's credit is still there
});
