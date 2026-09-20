import { expect, test, type Page } from '@playwright/test';
import { gridToLonLat, lonLatToGrid } from '../src/lcc.ts';
import { areaOf, clickPaneAt, clickPlace, COVERED, GROUND, leadingNumber, lengthBetween, openApp, paneGeometry, paneReadout, shownFrame } from './support.ts';

// The scene, end to end, on the made-up photo: photos draped on the map with the look direction up, and the measuring
// tools working on it. On this flat ground the drawn plane is the true ground, so a click's position on the map is
// also a ground position, and the expected numbers come from the map alone (unproject), not from the app's camera.

async function startScene(page: Page): Promise<void> {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(page.locator('#photo .photo-canvas')).toBeVisible();
  await expect(page.locator('#photo footer .info')).toHaveText(/^Preview at/);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await expect(page.locator('.measure-bar.in-scene')).toBeVisible();
  await expect(page.locator('#photo')).toHaveClass(/tucked/);
  await page.waitForFunction(() => window.__map!.getLayer('drape') !== undefined); // the chosen photo is on the map
  await expect(page.locator('.scene-status')).toBeHidden({ timeout: 30_000 });
}

/** A place on the map at a ground offset (feet) from the covered point: the page position, whole pixels, and the ground that position is. */
async function mapSpot(page: Page, dx: number, dy: number): Promise<{ x: number; y: number; ground: { x: number; y: number } }> {
  const [x0, y0] = lonLatToGrid(COVERED[0], COVERED[1]);
  const [lon, lat] = gridToLonLat(x0 + dx, y0 + dy);
  const spot = await page.evaluate(([lo, la]) => {
    const p = window.__map!.project([lo, la]);
    const box = window.__map!.getCanvas().getBoundingClientRect();
    return { x: Math.round(box.left + p.x), y: Math.round(box.top + p.y), left: box.left, top: box.top };
  }, [lon, lat] as const);
  const back = await page.evaluate(([px, py]) => {
    const l = window.__map!.unproject([px, py]);
    return [l.lng, l.lat];
  }, [spot.x - spot.left, spot.y - spot.top] as const);
  const [gx, gy] = lonLatToGrid(back[0]!, back[1]!);
  return { x: spot.x, y: spot.y, ground: { x: gx, y: gy } };
}

const sceneReadout = async (page: Page): Promise<Record<string, string>> => {
  const terms = await page.locator('.measure-bar.in-scene .measure-readout dt').allTextContents();
  const values = await page.locator('.measure-bar.in-scene .measure-readout dd').allTextContents();
  return Object.fromEntries(terms.map((t, i) => [t, values[i]!]));
};
const sceneTool = (page: Page, name: string) => page.locator('.measure-bar.in-scene').getByRole('button', { name, exact: true }).click();

test('turning the scene on shows the toolbar, tucks the pane and turns the map so the look direction is up', async ({ page }) => {
  await startScene(page);
  const bearing = await page.evaluate(() => window.__map!.getBearing());
  // The list is looking north, and the photo is a Fwd or Bwd one (looking about north or south): the map is turned to 0.
  expect(Math.abs(bearing)).toBeLessThan(1);
  await expect(page.locator('.measure-bar.in-scene .measure-tools button')).toHaveCount(7);
  await expect(page.locator('#photo').getByRole('button', { name: 'Open the photo' })).toBeVisible();
});

test('a click on the map measures in the photo, and the result is drawn on the map with its labels', async ({ page }) => {
  await startScene(page);
  await sceneTool(page, 'Distance');
  const a = await mapSpot(page, -40, -10), b = await mapSpot(page, 60, 20);
  await page.mouse.click(a.x, a.y);
  await expect(page.locator('.measure-bar.in-scene .measure-readout')).toContainText('Click the next point');
  await page.mouse.click(b.x, b.y);
  await expect.poll(async () => (await sceneReadout(page))['Distance']).toBeTruthy();
  const expected = lengthBetween(a.ground, b.ground);
  expect(expected).toBeGreaterThan(80);
  expect(Math.abs(leadingNumber((await sceneReadout(page))['Distance']!) - expected)).toBeLessThan(0.6); // click positions are whole screen pixels
  await expect.poll(() => page.evaluate(() => window.__map!.querySourceFeatures('measure').length)).toBeGreaterThanOrEqual(3); // a line and two dots
  await expect(page.locator('.measure-label')).toHaveCount(1);
  // While a tool is on, a click on the map measures and does not look up a new place: the list is unchanged.
  await expect(page.locator('#panel .frames .frame').first()).toHaveAttribute('aria-pressed', 'true');
});

test('Area in the scene, on the zoomed map where the mosaic of photos is drawn', async ({ page }) => {
  await startScene(page);
  await page.evaluate(([lon, lat]) => window.__map!.jumpTo({ center: [lon, lat], zoom: 17 }), COVERED); // close enough for the mosaic
  await page.waitForFunction(() => window.__detail?.lastStats != null, null, { timeout: 60_000 });
  await sceneTool(page, 'Area');
  const spots = [await mapSpot(page, -20, -20), await mapSpot(page, 20, -20), await mapSpot(page, 20, 20), await mapSpot(page, -20, 20)];
  for (const s of spots) { await page.mouse.click(s.x, s.y); await page.waitForTimeout(400); }
  await expect.poll(async () => (await sceneReadout(page))['Area']).toBeTruthy();
  const expected = areaOf(spots.map((s) => s.ground));
  expect(expected).toBeGreaterThan(1200); // about 1,600 ft²
  expect(Math.abs(leadingNumber((await sceneReadout(page))['Area']!) / expected - 1)).toBeLessThan(0.02);
});

test('a measurement made in the pane is drawn in another photo when you choose it', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(page.locator('#photo footer .info')).toHaveText(/^Preview at/);
  const first = await shownFrame(page);
  const [x, y] = lonLatToGrid(COVERED[0], COVERED[1]);
  await page.locator('#photo').getByRole('button', { name: 'Surface location', exact: true }).click();
  await clickPaneAt(page, first, { x, y, z: GROUND });
  await expect.poll(async () => (await paneReadout(page))['Latitude, longitude']).toBeTruthy();

  await page.locator('#panel .frames .frame').nth(1).click();
  await expect.poll(async () => (await page.locator('#photo .name').textContent())!.trim()).not.toBe(first.filename);
  await expect(page.locator('#photo footer .info')).toHaveText(/^Preview at/);
  const second = await shownFrame(page);
  const pane = await paneGeometry(page, second.cam);
  const at = second.cam.groundToPixel(x, y, GROUND)!;
  const spot = pane.toPage(at[0], at[1]);
  // The measurement's first dot is white with an amber ring: look for amber around where this photo sees the point.
  const found = await page.locator('#photo .photo-canvas').evaluate((c: HTMLCanvasElement, [px, py]) => {
    const ctx = c.getContext('2d')!;
    const r = c.getBoundingClientRect();
    const cx = Math.round(px! - r.left), cy = Math.round(py! - r.top);
    const data = ctx.getImageData(cx - 12, cy - 12, 25, 25).data;
    for (let i = 0; i < data.length; i += 4) if (data[i]! > 240 && Math.abs(data[i + 1]! - 179) < 14 && data[i + 2]! < 30) return true;
    return false;
  }, [spot.x, spot.y]);
  expect(found).toBe(true);
});

// Distances and areas do not change if every click is shifted the same way, so an absolute position needs its own test:
// Surface location in the scene must land where the click was, whichever way the app finds the photo under the click
// (the mosaic's photo when one is drawn, else the chosen photo's preview when zoomed out).
for (const view of [{ name: 'zoomed out, before the mosaic', zoom: 13 }, { name: 'the fitted view', zoom: null }, { name: 'zoomed in', zoom: 17 }]) {
  test(`Surface location in the scene lands where the click was (${view.name})`, async ({ page }) => {
    await startScene(page);
    if (view.zoom !== null) await page.evaluate(([lon, lat, z]) => window.__map!.jumpTo({ center: [lon!, lat!], zoom: z! }), [COVERED[0], COVERED[1], view.zoom]);
    if (view.zoom === 13) await page.waitForFunction(() => window.__detail?.lastStats == null); // no mosaic here: the chosen photo's preview is what shows
    else await page.waitForFunction(() => window.__detail?.lastStats != null, null, { timeout: 60_000 });
    await sceneTool(page, 'Surface location');
    const spot = await mapSpot(page, 120, -80);
    await page.mouse.click(spot.x, spot.y);
    await expect.poll(async () => (await sceneReadout(page))['Latitude, longitude']).toBeTruthy();
    const [lon, lat] = gridToLonLat(spot.ground.x, spot.ground.y);
    const [gotLat, gotLon] = (await sceneReadout(page))['Latitude, longitude']!.split(', ').map(Number);
    expect(Math.abs(gotLon! - lon)).toBeLessThan(2e-6); // about 0.2 m
    expect(Math.abs(gotLat! - lat)).toBeLessThan(2e-6);
  });
}
