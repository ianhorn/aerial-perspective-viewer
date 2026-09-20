import { expect, test } from '@playwright/test';
import { clickPlace, COVERED, drawnFootprint, openApp, pixelOf, UNCOVERED } from './support.ts';

// The click-a-place lookup, end to end: the map, the API, the database and the panel. These are the checks that were
// scratch scripts until now. Several of them catch what no unit test can: the map's layers not being drawn at all.

test('the app starts with a map, the prompt and no footprint', async ({ page }) => {
  const outside = await openApp(page);
  await expect(page).toHaveTitle('Kentucky Aerial Perspective Viewer');
  await expect(page.locator('#panel .where')).toHaveText('Click the map to pick a location.');
  await expect(page.locator('#photo')).toBeHidden();
  expect(await drawnFootprint(page)).toBe('');
  expect(outside.strays).toEqual([]);
  expect(outside.errors).toEqual([]);
});

test('clicking a covered place lists photos that look north, and draws the footprint over the click', async ({ page }) => {
  const outside = await openApp(page);
  await clickPlace(page, COVERED);

  await expect(page.getByRole('button', { name: 'North', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // The lookup gets the best 20 photos; the list shows the first five and adds more as it is scrolled.
  await expect(page.locator('#panel .status')).toHaveText('The 20 best photos cover this point, best first. Scroll for more.');
  const rows = page.locator('#panel .frames .frame');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true'); // the best photo is chosen for the user
  // Every listed photo looks north (Fwd or Bwd, flown either way) and none carries the "looks away" caveat.
  for (const title of await rows.locator('strong').allTextContents()) expect(title).toMatch(/^Looking (north|northwest|northeast)$/);
  await expect(page.locator('#panel .note', { hasText: 'away from' })).toHaveCount(0);

  // The footprint is really drawn (not just in the map's data), and it covers the point that was clicked.
  await expect.poll(() => drawnFootprint(page)).not.toBe('');
  const at = await pixelOf(page, COVERED); // after the pane has opened and narrowed the map
  const covering = await page.evaluate(({ x, y }) => window.__map!.queryRenderedFeatures([x, y], { layers: ['frame-fill'] }).length, at);
  expect(covering).toBeGreaterThan(0);
  expect(outside.strays).toEqual([]);
  expect(outside.errors).toEqual([]);
});

test('another direction lists other photos and moves the footprint; another photo moves it again', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  await expect(page.locator('#panel .frames .frame')).toHaveCount(5);
  await expect.poll(() => drawnFootprint(page)).not.toBe('');
  const north = await drawnFootprint(page);
  const northTitles = await page.locator('#panel .frames strong').allTextContents();

  await page.getByRole('button', { name: 'East', exact: true }).click();
  await expect(page.getByRole('button', { name: 'East', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#panel .status')).toHaveText(/best first\./);
  await expect.poll(async () => (await page.locator('#panel .frames strong').allTextContents()).join()).not.toBe(northTitles.join());
  for (const title of await page.locator('#panel .frames strong').allTextContents()) expect(title).toMatch(/^Looking (east|northeast|southeast)$/);
  await expect.poll(() => drawnFootprint(page)).not.toBe(north);

  const east = await drawnFootprint(page);
  await page.locator('#panel .frames .frame').nth(1).click();
  await expect(page.locator('#panel .frames .frame').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => drawnFootprint(page)).not.toBe(east);
});

test('a click outside the imagery says so and clears the footprint', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  await expect.poll(() => drawnFootprint(page)).not.toBe('');

  await clickPlace(page, UNCOVERED);
  await expect(page.locator('#panel .status')).toHaveText('No photos cover this point.');
  await expect(page.locator('#panel .frames .frame')).toHaveCount(0);
  await expect.poll(() => drawnFootprint(page)).toBe('');
  await expect(page.locator('#photo')).toBeHidden();
});

test('when the API fails, the panel says so in plain words', async ({ page }) => {
  await openApp(page);
  await page.route('**/api/frames?*', (route) => route.fulfill({ status: 503, json: { error: 'database_unavailable' } }));
  await clickPlace(page, COVERED);
  await expect(page.locator('#panel .status')).toHaveText('The photo service did not answer. Try again in a moment.');
  expect(await drawnFootprint(page)).toBe('');
});
