import { expect, test } from '@playwright/test';
import { clickPlace, COVERED, openApp } from './support.ts';

// The results list: a few photos to begin with and more as it is scrolled, bigger pictures, and a preview of a photo's
// footprint on the map while the pointer is over its card.

const rows = (page: import('@playwright/test').Page) => page.locator('#panel .frames .frame');
const thumbs = (page: import('@playwright/test').Page) => page.locator('#panel .frames .thumb canvas');
const scrollPanelToEnd = (page: import('@playwright/test').Page) => page.locator('#panel').evaluate((el) => { el.scrollTo(0, el.scrollHeight); });
const showMore = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /^Show \d+ more photos?$/ }).click();

test('the list starts with five photos and their pictures, and adds five more, with pictures, each time it is scrolled near the end', async ({ page }) => {
  const outside = await openApp(page, { photos: 'fixture' });
  await page.setViewportSize({ width: 1400, height: 620 }); // short enough that the panel scrolls
  await clickPlace(page, COVERED);
  await expect(rows(page)).toHaveCount(5);
  await expect(thumbs(page)).toHaveCount(5, { timeout: 30_000 });
  await expect(page.locator('#panel .status')).toContainText('Scroll for more.');
  // Photos that are not shown have no picture made for them yet: only these five (and the pane's, the first) were read.
  const filesBefore = new Set(outside.photoRequests.filter((r) => r.url.endsWith('.tif')).map((r) => r.url));
  expect(filesBefore.size).toBeLessThanOrEqual(5);

  await scrollPanelToEnd(page);
  await expect(rows(page)).toHaveCount(10);
  await expect(thumbs(page)).toHaveCount(10, { timeout: 30_000 });
  expect(await page.locator('#panel').evaluate((el) => el.scrollTop)).toBeGreaterThan(100); // adding rows did not throw the scroll back to the top
  const filesAfter = new Set(outside.photoRequests.filter((r) => r.url.endsWith('.tif')).map((r) => r.url));
  expect(filesAfter.size).toBeGreaterThan(filesBefore.size);

  // Keep going to the end: 20 in all, and then the note about scrolling and the button go.
  for (let i = 0; i < 6 && (await rows(page).count()) < 20; i++) { await scrollPanelToEnd(page); await page.waitForTimeout(500); }
  await expect(rows(page)).toHaveCount(20);
  await expect(thumbs(page)).toHaveCount(20, { timeout: 60_000 });
  await expect(page.locator('#panel .status')).not.toContainText('Scroll for more');
  await expect(page.locator('#panel .frames .more')).toHaveCount(0);
});

test('a panel too tall to scroll never grows by itself, and its button adds five more', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(rows(page)).toHaveCount(5);
  expect(await page.locator('#panel').evaluate((el) => el.scrollHeight <= el.clientHeight + 2)).toBe(true); // nothing to scroll
  await page.waitForTimeout(1500);
  await expect(rows(page)).toHaveCount(5); // and it stayed at five
  await expect(page.getByRole('button', { name: 'Show 5 more photos' })).toBeVisible();
  await showMore(page);
  await expect(rows(page)).toHaveCount(10);
  await expect(thumbs(page)).toHaveCount(10, { timeout: 30_000 });
});

test('the numbers on the cards run on in order, and choosing a photo further down works', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await showMore(page);
  await expect(rows(page)).toHaveCount(10);
  expect(await page.locator('#panel .frames .thumb .num').allTextContents()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  const name = await rows(page).nth(7).locator('strong').textContent();
  await rows(page).nth(7).click();
  await expect(rows(page).nth(7)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#photo h2')).toHaveText(name!);
});

test('the pictures are wide (180 by 100) and the text is pushed to the right, nearly to the edge of the panel', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  const thumb = (await page.locator('#panel .frames .thumb').first().boundingBox())!;
  const body = (await page.locator('#panel .frames .body').first().boundingBox())!;
  const panel = (await page.locator('#panel').boundingBox())!;
  expect(Math.round(thumb.width)).toBe(180);
  expect(Math.round(thumb.height)).toBe(100);
  expect(body.x).toBeGreaterThanOrEqual(thumb.x + thumb.width); // the text sits to the right of the picture
  expect(body.x + body.width).toBeLessThanOrEqual(panel.x + panel.width); // and stays inside the panel
  expect(panel.x + panel.width - (body.x + body.width)).toBeLessThan(40); // reaching nearly to the panel's right edge
  expect(thumb.width / panel.width).toBeGreaterThan(0.42); // the picture takes a good part of the row
  // The date is never split across lines in the narrower column (it was broken at a hyphen: 2024- / 03-19).
  const dates = page.locator('#panel .frames .facts .nowrap');
  expect(await dates.count()).toBe(5);
  for (const rects of await dates.evaluateAll((els) => els.map((e) => e.getClientRects().length))) expect(rects).toBe(1);
  await expect(dates.first()).toHaveText(/^flown \d{4}-\d{2}-\d{2}$/);
  await expect(page.locator('#panel .frames .facts').first()).toHaveText(/^\w+ camera · flown \d{4}-\d{2}-\d{2} · about [\d.]+ ft per pixel here/);
});

test('the pointer on a card previews that photo\'s footprint on the map, and it goes when the pointer leaves', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(rows(page)).toHaveCount(5);
  const hovered = () => page.evaluate(() => window.__map!.queryRenderedFeatures(undefined, { layers: ['frame-hover-outline'] }).length);
  const shape = () => page.evaluate(() => JSON.stringify(window.__map!.querySourceFeatures('frame-hover')[0]?.geometry ?? null));
  expect(await hovered()).toBe(0);

  await rows(page).nth(3).hover();
  await expect.poll(hovered).toBeGreaterThan(0);
  const third = await shape();
  const selected = await page.evaluate(() => JSON.stringify(window.__map!.querySourceFeatures('frame').find((f) => f.geometry.type === 'Polygon')?.geometry ?? null));
  expect(third).not.toBe(selected); // it is another photo's footprint, not the chosen one's

  await rows(page).nth(1).hover();
  await expect.poll(shape).not.toBe(third); // moving to another card moves the preview

  await page.mouse.move(700, 500); // off the list, over the map
  await expect.poll(hovered).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__map!.querySourceFeatures('frame-hover').length)).toBe(0);
});

test('the preview shows when the map is zoomed out, which is what it is for', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(rows(page)).toHaveCount(5);
  await page.evaluate(([lon, lat]) => window.__map!.jumpTo({ center: [lon!, lat!], zoom: 9, padding: { left: 420 } }), COVERED);
  await rows(page).nth(2).hover();
  await expect.poll(() => page.evaluate(() => window.__map!.queryRenderedFeatures(undefined, { layers: ['frame-hover-outline'] }).length)).toBeGreaterThan(0);
});

test('keyboard focus on a card previews its footprint too, and leaving it clears it', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(rows(page)).toHaveCount(5);
  await rows(page).nth(2).focus();
  await expect.poll(() => page.evaluate(() => window.__map!.querySourceFeatures('frame-hover').length)).toBeGreaterThanOrEqual(1);
  await rows(page).nth(2).blur();
  await expect.poll(() => page.evaluate(() => window.__map!.querySourceFeatures('frame-hover').length)).toBe(0);
});

test('a photo loading does not cancel a move the map is making', async ({ page }) => {
  // The code that runs when a photo loads used to start a move of its own (turning the map to north when it was already north),
  // and starting any move ends the one in progress. That cancelled any pan or zoom animation the moment a photo loaded.
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(rows(page)).toHaveCount(5);
  await page.evaluate(() => window.__map!.easeTo({ zoom: 10, duration: 4000 })); // a slow move, still going as the next photo loads
  await rows(page).nth(2).click(); // another photo: its details and picture load, which runs that code
  await expect(page.locator('#photo footer .info')).toHaveText(/^Preview at/);
  await expect.poll(() => page.evaluate(() => window.__map!.getZoom()), { timeout: 15_000 }).toBeCloseTo(10, 1); // it got there
});
