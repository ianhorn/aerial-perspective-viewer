import { expect, test, type Page } from '@playwright/test';
import { gridToLonLat, lonLatToGrid } from '../src/lcc.ts';
import { areaOf, clickPaneAt, clickPlace, COVERED, GROUND, heightSeenAt, isAmber, isGreen, isWhite, leadingNumber, lengthBetween, openApp, paneGeometry, paneHasPixel, paneReadout, shownFrame } from './support.ts';

// The measuring tools on a photo, end to end: real clicks on the pane, through the app, the API and a made-up photo with a
// flat terrain patch (support.ts, fixture-photo.ts). Each expected number is worked out separately, from the camera model
// and the flat ground, for the very pixels that were clicked, so a click's few-foot resolution at this zoom does not matter.

const tool = (page: Page, name: string) => page.locator('#photo').getByRole('button', { name, exact: true }).click();

/** Open the app on the photo at the covered point, with the measuring tool chosen. Returns the frame and the clicked point's ground. */
async function ready(page: Page, toolName: string) {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  await expect(page.locator('#photo .photo-canvas')).toBeVisible();
  await expect(page.locator('#photo footer .info')).toHaveText(/^Preview at/);
  const frame = await shownFrame(page);
  const [x, y] = lonLatToGrid(COVERED[0], COVERED[1]);
  await tool(page, toolName);
  return { frame, x, y };
}

test('Distance: the level length of a path, from real clicks', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Distance');
  const a = (await clickPaneAt(page, frame, { x: x - 60, y, z: GROUND }))!;
  const b = (await clickPaneAt(page, frame, { x: x + 60, y: y + 40, z: GROUND }))!;
  const expected = lengthBetween(a.ground, b.ground);
  expect(expected).toBeGreaterThan(80); // a sane test: about 144 ft
  await expect.poll(async () => leadingNumber((await paneReadout(page))['Distance'] ?? '0')).toBeGreaterThan(0);
  const read = await paneReadout(page);
  expect(Math.abs(leadingNumber(read['Distance']!) - expected)).toBeLessThan(0.15);
  expect(read['Along the slope']).toMatch(/^\d/); // flat ground: the same length
  expect(Math.abs(leadingNumber(read['Along the slope']!) - expected)).toBeLessThan(0.15);
  await expect(page.locator('#photo .photo-canvas')).toHaveAttribute('data-tooling', 'true');
});

test('Distance 3D: the same length on flat ground, and no change in height', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Distance 3D');
  const a = (await clickPaneAt(page, frame, { x, y: y - 50, z: GROUND }))!;
  const b = (await clickPaneAt(page, frame, { x: x + 30, y: y + 50, z: GROUND }))!;
  const expected = lengthBetween(a.ground, b.ground);
  await expect.poll(async () => (await paneReadout(page))['Distance 3D']).toBeTruthy();
  const read = await paneReadout(page);
  expect(Math.abs(leadingNumber(read['Distance 3D']!) - expected)).toBeLessThan(0.15);
  expect(read['Elevation change']).toMatch(/^[+−]?0\.0 ft/);
  expect(read['Slope']).toBe('0.0%');
});

test('Area and Area 3D: the area of a four-cornered outline, flat and along the ground', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Area');
  const corners = [[-50, -40], [50, -40], [50, 40], [-50, 40]];
  const grounds = [];
  for (const [dx, dy] of corners) grounds.push((await clickPaneAt(page, frame, { x: x + dx!, y: y + dy!, z: GROUND }))!.ground);
  const expected = areaOf(grounds);
  expect(expected).toBeGreaterThan(5000); // about 8,000 ft²
  await expect.poll(async () => (await paneReadout(page))['Area']).toBeTruthy();
  let read = await paneReadout(page);
  expect(Math.abs(leadingNumber(read['Area']!) / expected - 1)).toBeLessThan(0.002);
  expect(read['Perimeter']).toMatch(/ft/);

  await tool(page, 'Area 3D');
  for (const [dx, dy] of corners) await clickPaneAt(page, frame, { x: x + dx!, y: y + dy!, z: GROUND });
  await expect.poll(async () => (await paneReadout(page))['Surface area']).toBeTruthy();
  read = await paneReadout(page);
  expect(Math.abs(leadingNumber(read['Surface area']!) / expected - 1)).toBeLessThan(0.002); // flat ground: no more than the flat area
  expect(read['Steeper by']).toBe('0.0%');
});

test('Height: how high the top of something is above its base', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Height');
  const base = (await clickPaneAt(page, frame, { x, y, z: GROUND }))!;
  await expect(page.locator('#photo .measure-readout')).toContainText('click the top');
  const top = (await clickPaneAt(page, frame, { x: base.ground.x, y: base.ground.y, z: GROUND + 40 }))!;
  // What the top's pixel means from the base the click really made.
  const expected = heightSeenAt(frame.cam, base.ground, top.col, top.row);
  expect(expected).toBeGreaterThan(30); // about 40 ft
  expect(expected).toBeLessThan(50);
  await expect.poll(async () => (await paneReadout(page))['Height']).toBeTruthy();
  const read = await paneReadout(page);
  expect(Math.abs(leadingNumber(read['Height']!) - expected)).toBeLessThan(0.15);
  expect(read['Ground elevation']).toMatch(/^500\.0 ft/);
  expect(Math.abs(leadingNumber(read['Top elevation']!) - (GROUND + expected))).toBeLessThan(0.15);
  await expect(page.locator('#photo .measure-readout .warning')).toHaveCount(0); // the top was straight above the base
});

test('Height: a top far to the side of the line above the base gets a warning', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Height');
  await clickPaneAt(page, frame, { x, y, z: GROUND });
  await clickPaneAt(page, frame, { x: x + 250, y: y + 250, z: GROUND + 40 }); // well off the vertical above the base
  await expect(page.locator('#photo .measure-readout .warning')).toContainText('to the side');
});

test('Surface location: latitude, longitude and the ground elevation of a click', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Surface location');
  const spot = (await clickPaneAt(page, frame, { x: x + 25, y: y - 15, z: GROUND }))!;
  await expect.poll(async () => (await paneReadout(page))['Latitude, longitude']).toBeTruthy();
  const read = await paneReadout(page);
  const [lon, lat] = gridToLonLat(spot.ground.x, spot.ground.y);
  expect(read['Latitude, longitude']).toBe(`${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  expect(read['Ground elevation']).toMatch(/^500\.0 ft/);
  expect(read['State Plane (EPSG:3089)']).toContain('ft');
  // Degrees, minutes and seconds under the decimal degrees, and the same place.
  const dms = read['Degrees, minutes, seconds']!;
  expect(dms).toMatch(/^\d+° \d\d′ \d\d\.\d\d″ N, \d+° \d\d′ \d\d\.\d\d″ W$/);
  const [a, b] = dms.split(', ').map((part) => { const m = /^(\d+)° (\d+)′ ([\d.]+)″/.exec(part)!; return +m[1]! + +m[2]! / 60 + +m[3]! / 3600; });
  expect(Math.abs(a! - lat)).toBeLessThan(0.02 / 3600 + 1e-9);
  expect(Math.abs(b! - Math.abs(lon))).toBeLessThan(0.02 / 3600 + 1e-9);
});

test('Location 3D: where the top point is, in the air', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Location 3D');
  const base = (await clickPaneAt(page, frame, { x, y, z: GROUND }))!;
  const top = (await clickPaneAt(page, frame, { x: base.ground.x, y: base.ground.y, z: GROUND + 60 }))!;
  const expected = heightSeenAt(frame.cam, base.ground, top.col, top.row);
  await expect.poll(async () => (await paneReadout(page))['Elevation']).toBeTruthy();
  const read = await paneReadout(page);
  expect(Math.abs(leadingNumber(read['Elevation']!) - (GROUND + expected))).toBeLessThan(0.15);
  expect(Math.abs(leadingNumber(read['Height above ground']!) - expected)).toBeLessThan(0.15);
  const [lon, lat] = gridToLonLat(base.ground.x, base.ground.y);
  expect(read['Latitude, longitude']).toBe(`${lat.toFixed(6)}, ${lon.toFixed(6)}`); // the top is straight above its base
});

test('Undo (Backspace) takes back the last point, and Escape clears before it turns the tool off', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Distance');
  const a = (await clickPaneAt(page, frame, { x: x - 60, y, z: GROUND }))!;
  const b = (await clickPaneAt(page, frame, { x: x + 60, y, z: GROUND }))!;
  await clickPaneAt(page, frame, { x: x + 60, y: y + 90, z: GROUND });
  await expect.poll(async () => (await page.locator('#photo .measure-readout .prompt').textContent()) ?? '').toContain('3 points');
  await page.keyboard.press('Backspace');
  await expect(page.locator('#photo .measure-readout .prompt')).not.toContainText('3 points');
  const read = await paneReadout(page);
  expect(Math.abs(leadingNumber(read['Distance']!) - lengthBetween(a.ground, b.ground))).toBeLessThan(0.15);

  await page.keyboard.press('Escape'); // clears the measurement, the tool stays on
  await expect(page.locator('#photo').getByRole('button', { name: 'Distance', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#photo .measure-readout dl')).toHaveCount(0);
  await page.keyboard.press('Escape'); // now it turns the tool off, and the pane is still open
  await expect(page.locator('#photo').getByRole('button', { name: 'Distance', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#photo')).toBeVisible();
});

test('with a tool on, a click on the photo measures and does not drop the dot on the map', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Surface location');
  await clickPaneAt(page, frame, { x, y, z: GROUND });
  await expect.poll(async () => (await paneReadout(page))['Latitude, longitude']).toBeTruthy();
  expect(await page.evaluate(() => window.__map!.querySourceFeatures('photo-pick').length)).toBe(0);
});

test('Height: while the top is being placed, a line follows the cursor, with the true vertical to compare it with; it is green when plumb', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Height');
  const base = (await clickPaneAt(page, frame, { x, y, z: GROUND }))!;
  const pane = await paneGeometry(page, frame.cam);
  const at = (dx: number, dy: number, up: number) => {
    const px = frame.cam.groundToPixel(base.ground.x + dx, base.ground.y + dy, GROUND + up)!;
    return pane.toPage(px[0], px[1]);
  };
  const middle = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const start = at(0, 0, 0);
  // At this zoom 40 ft is only a few screen pixels, which would be all marker, so look at a tall one: 300 ft is about 50 px.
  const HEIGHT = 300;

  // The cursor straight above the base: the line to it is green.
  const plumb = at(0, 0, HEIGHT);
  await page.mouse.move(Math.round(plumb.x), Math.round(plumb.y), { steps: 4 });
  await expect.poll(() => paneHasPixel(page, middle(start, plumb), 3, isGreen)).toBe(true);
  expect(await paneHasPixel(page, middle(start, plumb), 3, isAmber)).toBe(false);
  // The true vertical above the base is drawn (dashed white) past the cursor, to 1.6 times its height: look along it.
  let whites = 0;
  for (let up = HEIGHT + 20; up <= HEIGHT * 1.6 - 20; up += 8) if (await paneHasPixel(page, at(0, 0, up), 1, isWhite)) whites++;
  expect(whites).toBeGreaterThanOrEqual(3);

  // The cursor off to the side: the line to it is amber, not green.
  const aside = at(300, 0, HEIGHT);
  await page.mouse.move(Math.round(aside.x), Math.round(aside.y), { steps: 4 });
  await expect.poll(() => paneHasPixel(page, middle(start, aside), 3, isAmber)).toBe(true);
  expect(await paneHasPixel(page, middle(start, aside), 3, isGreen)).toBe(false);

  // Placing the top ends the preview: no green line follows the cursor any more.
  await page.mouse.move(Math.round(plumb.x), Math.round(plumb.y), { steps: 2 });
  await page.mouse.click(Math.round(plumb.x), Math.round(plumb.y));
  await expect.poll(async () => (await paneReadout(page))['Height']).toBeTruthy();
  await page.mouse.move(Math.round(plumb.x + 40), Math.round(plumb.y + 5), { steps: 3 });
  expect(await paneHasPixel(page, middle(start, plumb), 3, isGreen)).toBe(false);
});

test('Height: no line follows the cursor before the base is placed, or with another tool on', async ({ page }) => {
  const { frame, x, y } = await ready(page, 'Height');
  const pane = await paneGeometry(page, frame.cam);
  const some = pane.toPage(...(frame.cam.groundToPixel(x + 20, y, GROUND + 40)! as [number, number]));
  await page.mouse.move(Math.round(some.x), Math.round(some.y), { steps: 3 });
  for (const test of [isGreen, isAmber]) expect(await paneHasPixel(page, some, 40, test)).toBe(false);
});
