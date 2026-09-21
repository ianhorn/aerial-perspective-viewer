import { expect, test, type Page } from '@playwright/test';
import { gridToLonLat, lonLatToGrid } from '../src/lcc.ts';
import { COPC_TILE, openApp, showPlace } from './support.ts';

// The point cloud tool, in the real app, against a made-up catalogue and file server that serve one tiny COPC tile (test/fixtures/tiny.copc.laz:
// 10,000 points on a regular lattice, 50 ft apart, over a 5,000 ft tile; see test/support/make_copc.py). What is checked is what a person
// sees: points painted where that ground is (read from a screenshot of the map, against the map's own projection of the tile's corners),
// coloured by height, the numbers on the card, the requests that were made, and what happens when things go wrong.

const TILE_CENTRE = gridToLonLat(COPC_TILE.x + 2500, COPC_TILE.y + 2500);

/** Open the app at the tile with the point cloud stubs on. Zoom 14: the tile is about 400 px across. */
async function open(page: Page, pointClouds: { delayMs?: number; missing?: boolean } = {}) {
  const outside = await openApp(page, { pointClouds });
  await showPlace(page, TILE_CENTRE, 14);
  return outside;
}
const toggle = (page: Page) => page.getByRole('button', { name: 'Point cloud', exact: true });
const card = (page: Page) => page.locator('.pc-bar');
async function openCard(page: Page): Promise<void> {
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
}
const status = (page: Page) => card(page).locator('.pc-status');

/** The map's canvas position in the page (zero here, but not assumed). */
const canvasBox = async (page: Page) => (await page.locator('#map canvas').boundingBox())!;
async function project(page: Page, gridX: number, gridY: number): Promise<{ x: number; y: number }> {
  const box = await canvasBox(page);
  const p = await page.evaluate((lonlat) => { const q = window.__map!.project(lonlat as [number, number]); return { x: q.x, y: q.y }; }, gridToLonLat(gridX, gridY));
  return { x: p.x + box.x, y: p.y + box.y };
}

interface Paint { count: number; minX: number; maxX: number; minY: number; maxY: number; at: [number, number, number][]; yellow: { minX: number; maxX: number; minY: number; maxY: number; count: number } }
/** Look at a screenshot: where the pixels that differ from the map's empty background (read at the region's top-left corner) are, and the colour at some places. Only the middle of the page is looked at, clear of the panels and buttons. */
async function paint(page: Page, probes: { x: number; y: number }[] = [], yellowNear: { x: number; y: number } = { x: 0, y: 0 }, reach = 32): Promise<Paint & { background: [number, number, number] }> {
  // the dashed outline of the area is not what is being measured
  await page.evaluate(() => new Promise<void>((done) => { const m = window.__map!; m.setLayoutProperty('pc-areas-line', 'visibility', 'none'); m.once('idle', () => done()); m.triggerRepaint(); }));
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async ([data, points, near, reach]) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const [x0, y0, x1, y1] = [600, 180, 1250, 800]; // clear of the panel and of every button
    const corner = ctx.getImageData(x0 + 2, y0 + 2, 1, 1).data;
    const bg = [corner[0]!, corner[1]!, corner[2]!] as [number, number, number];
    const pixels = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let count = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < x1 - x0; x++) {
        const i = (y * (x1 - x0) + x) * 4;
        if (Math.abs(pixels[i]! - bg[0]!) + Math.abs(pixels[i + 1]! - bg[1]!) + Math.abs(pixels[i + 2]! - bg[2]!) > 24) {
          count++; minX = Math.min(minX, x + x0); maxX = Math.max(maxX, x + x0); minY = Math.min(minY, y + y0); maxY = Math.max(maxY, y + y0);
        }
      }
    }
    const at = (points as { x: number; y: number }[]).map((p) => { const d = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data; return [d[0]!, d[1]!, d[2]!] as [number, number, number]; });
    // the top of the ramp, yellow, within `reach` px of a place: on the made-up tile that is the "building" and nothing else nearby
    const size = reach * 2 + 1;
    const win = ctx.getImageData(Math.round(near.x) - reach, Math.round(near.y) - reach, size, size).data;
    const yellow = { minX: 1e9, maxX: -1, minY: 1e9, maxY: -1, count: 0 };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (win[i]! > 225 && win[i + 1]! > 205 && win[i + 2]! < 90) { yellow.count++; yellow.minX = Math.min(yellow.minX, x); yellow.maxX = Math.max(yellow.maxX, x); yellow.minY = Math.min(yellow.minY, y); yellow.maxY = Math.max(yellow.maxY, y); }
    }
    yellow.minX += Math.round(near.x) - reach; yellow.maxX += Math.round(near.x) - reach; yellow.minY += Math.round(near.y) - reach; yellow.maxY += Math.round(near.y) - reach;
    return { count, minX, maxX, minY, maxY, at, yellow, background: bg };
  }, [png, probes, yellowNear, reach] as const);
}

/** A lattice point's position on the ground: the made-up file has one every 50 ft, 100 by 100 (make_copc.py). */
function latticeInside(polygonGrid: [number, number][]): number {
  const inside = (x: number, y: number): boolean => {
    let hit = false;
    for (let i = 0, j = polygonGrid.length - 1; i < polygonGrid.length; j = i++) {
      const [ax, ay] = polygonGrid[i]!, [bx, by] = polygonGrid[j]!;
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
    }
    return hit;
  };
  let n = 0;
  for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) if (inside(COPC_TILE.x + (i + 0.5) * 50, COPC_TILE.y + (j + 0.5) * 50)) n++;
  return n;
}
/** Metres a screen pixel covers at the middle of the map's view now (MapLibre's zoom counts 512 px tiles). */
const metresPerPixelNow = (page: Page): Promise<number> =>
  page.evaluate(() => { const m = window.__map!; return (78271.51696 * Math.cos((m.getCenter().lat * Math.PI) / 180)) / 2 ** m.getZoom(); });
const numberIn = (text: string): number => Number(/([\d,]+) points/.exec(text)![1]!.replace(/,/g, ''));

test('nothing about point clouds is fetched or started until the tool is used', async ({ page }) => {
  const outside = await open(page);
  await openCard(page);
  await page.waitForTimeout(300);
  expect(outside.pointCloudRequests).toEqual([]);
  expect(outside.strays).toEqual([]);
  await expect(card(page).getByRole('button', { name: 'Use current view' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Draw an area' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Clear point cloud' })).toBeDisabled();
});

test('the view: points are painted on the ground they belong to, coloured by height, from range requests only', async ({ page }) => {
  const outside = await open(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Use current view' }).click();
  await expect(status(page)).toContainText('On the map: 10,000 points');
  // the view was bigger than the limit, so the middle of it was used, and the card says so
  await expect(card(page)).toContainText('bigger than the 4 square miles allowed at once');
  await expect(card(page).locator('.pc-ramp-ends')).toContainText(/\d+ ft/);
  await toggle(page).click(); // put the card away, so it is not over the map
  await expect(card(page)).toBeHidden();
  await page.waitForTimeout(400);

  // where the map puts the tile's first and last points (each is 25 ft in from the tile's edge), north up
  const west = await project(page, COPC_TILE.x + 25, COPC_TILE.y + 2500), east = await project(page, COPC_TILE.x + 4975, COPC_TILE.y + 2500);
  const south = await project(page, COPC_TILE.x + 2500, COPC_TILE.y + 25), north = await project(page, COPC_TILE.x + 2500, COPC_TILE.y + 4975);
  const centre = await project(page, COPC_TILE.x + 2500, COPC_TILE.y + 2500);
  const corner = await project(page, COPC_TILE.x + 300, COPC_TILE.y + 300);
  const seen = await paint(page, [centre, corner, { x: west.x - 30, y: west.y }], centre);
  // The dots are a few pixels across, so an edge is judged to within a dot; the middle of what is painted is judged closely.
  const width = east.x - west.x, height = south.y - north.y;
  // (the coarse dots along the west and south edges are bigger than the fine ones along the east and north, which moves the middle by up to a dot's radius)
  expect(Math.abs((seen.minX + seen.maxX) / 2 - (west.x + east.x) / 2)).toBeLessThan(3.5);
  expect(Math.abs((seen.minY + seen.maxY) / 2 - (north.y + south.y) / 2)).toBeLessThan(3.5);
  expect(seen.maxX - seen.minX).toBeGreaterThan(width - 1);
  expect(seen.maxX - seen.minX).toBeLessThan(width + 12); // the ground plus a coarse dot and a fine one at the ends: not the 3% too big of a cloud drawn at its real height
  expect(seen.maxY - seen.minY).toBeGreaterThan(height - 1);
  expect(seen.maxY - seen.minY).toBeLessThan(height + 12);
  // the "building" in the middle is the highest ground: the top of the ramp, yellow, and its middle is where the map puts the middle of the tile;
  // the corner is low: bluish, not yellow; outside the tile there is nothing
  expect(seen.yellow.count).toBeGreaterThan(1200);
  expect(Math.abs((seen.yellow.minX + seen.yellow.maxX) / 2 - centre.x)).toBeLessThan(4);
  expect(Math.abs((seen.yellow.minY + seen.yellow.maxY) / 2 - centre.y)).toBeLessThan(4);
  const [yc, lowc, out] = seen.at;
  expect(yc![0]).toBeGreaterThan(220); expect(yc![1]).toBeGreaterThan(200); expect(yc![2]).toBeLessThan(90);
  expect(lowc![0]).toBeLessThan(120);
  expect(Math.abs(out![0] - seen.background[0]) + Math.abs(out![1] - seen.background[1]) + Math.abs(out![2] - seen.background[2])).toBeLessThan(30);

  // Phase 3 was asked first, then Phase 2; the file was only ever read by range; and there was no other kind of request
  const searches = outside.pointCloudRequests.filter((r) => r.method === 'POST');
  expect(searches.map((r) => r.collection)).toEqual(['laz-phase3', 'laz-phase2']);
  const reads = outside.pointCloudRequests.filter((r) => r.method !== 'POST');
  expect(reads.length).toBeGreaterThan(3);
  expect(reads.every((r) => /^bytes=\d+-\d+$/.test(r.range ?? ''))).toBe(true);
  expect(outside.strays).toEqual([]);
  expect(outside.errors).toEqual([]);
});

test('the cloud stays on its ground when zoomed in and off-centre (its height is measured from the lowest ground, not from the sea)', async ({ page }) => {
  await open(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Use current view' }).click();
  await expect(status(page)).toContainText('On the map: 10,000 points');
  await toggle(page).click();
  // look at the tile from 600 ft west of its middle, at zoom 16: the "building" in the middle of the tile is now about 200 px right of the middle of the view.
  // A point drawn at its height above the sea (130 m up) through the map's camera would be about 12% too far out, 25 px, from the middle of the view.
  await page.evaluate(([lonlat]) => window.__map!.jumpTo({ center: lonlat as [number, number], zoom: 16, padding: { left: 420 } }), [gridToLonLat(COPC_TILE.x + 1900, COPC_TILE.y + 2500)] as const);
  await page.waitForTimeout(500);
  const building = await project(page, COPC_TILE.x + 2500, COPC_TILE.y + 2500);
  expect(building.x).toBeGreaterThan(1050);
  const seen = await paint(page, [], building, 130); // a window bigger than the building, so its edges are found and not the window's
  expect(seen.yellow.count).toBeGreaterThan(1000);
  expect(seen.yellow.maxX - seen.yellow.minX).toBeGreaterThan(120);
  expect(seen.yellow.maxX - seen.yellow.minX).toBeLessThan(250);
  expect(Math.abs((seen.yellow.minX + seen.yellow.maxX) / 2 - building.x)).toBeLessThan(9); // a few dots' width at this zoom, not 25 px
  expect(Math.abs((seen.yellow.minY + seen.yellow.maxY) / 2 - building.y)).toBeLessThan(9);
});

test('3D: points stand up at their height, stretch with the exaggeration, and lie down again in Flat; Tilt tilts the map', async ({ page }) => {
  test.setTimeout(120_000); // five screenshots read pixel by pixel, in a browser that draws in software: 25 s alone, more when the whole suite is running
  await open(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Use current view' }).click();
  await expect(status(page)).toContainText('On the map: 10,000 points');
  const three = card(page).getByRole('button', { name: '3D', exact: true }), flat = card(page).getByRole('button', { name: 'Flat', exact: true });
  const stretch = card(page).getByRole('combobox', { name: 'Height exaggeration' });
  await expect(three).toHaveAttribute('aria-pressed', 'true'); // 3D is what it starts as
  await expect(flat).toHaveAttribute('aria-pressed', 'false');
  await expect(stretch).toBeEnabled();

  // Tilt tilts the map, and again levels it
  const tilt = card(page).getByRole('button', { name: 'Tilt', exact: true });
  await tilt.click();
  await expect.poll(() => page.evaluate(() => window.__map!.getPitch())).toBeGreaterThan(50);
  await expect(tilt).toHaveAttribute('aria-pressed', 'true');
  await tilt.click();
  await expect.poll(() => page.evaluate(() => window.__map!.getPitch())).toBeLessThan(1);

  // Look at 60 degrees, zoom 16, the middle of the tile in the middle of the view. The "building" (the top of the ramp) stands up above the lowest ground
  // (the low end of the legend). A vertical rise of h metres is h / (metres a pixel) x sin(60 degrees) pixels on a map tilted 60 degrees from straight down
  // (a vertical line lies along the view when looking straight down, and across it when looking along the horizon). Flat is where the foot is.
  await page.evaluate(([lonlat]) => window.__map!.jumpTo({ center: lonlat as [number, number], zoom: 16, pitch: 60, padding: { left: 420 } }), [TILE_CENTRE] as const);
  const low = Number(/(\d+) ft/.exec(await card(page).locator('.pc-ramp-ends span').first().innerText())![1]);
  const roof = 420 + 20 * Math.sin(2500 / 700) * Math.cos(2500 / 900) + 40; // the made-up surface's height at the middle of the building (make_copc.py), in feet
  const metresPerPixel = await metresPerPixelNow(page);
  const expectedLift = (((roof - low) * 0.3048006) / metresPerPixel) * Math.sin(Math.PI / 3);
  const building = await project(page, COPC_TILE.x + 2500, COPC_TILE.y + 2500);
  const buildingAt = async (): Promise<{ x: number; y: number }> => {
    await page.waitForTimeout(500);
    const seen = await paint(page, [], building, 110);
    expect(seen.yellow.count).toBeGreaterThan(500);
    return { x: (seen.yellow.minX + seen.yellow.maxX) / 2, y: (seen.yellow.minY + seen.yellow.maxY) / 2 };
  };
  await flat.click();
  await expect(stretch).toBeDisabled(); // there is no height to stretch when flat
  const lying = await buildingAt();
  await three.click();
  const standing = await buildingAt();
  await stretch.selectOption('3');
  const stretched = await buildingAt();
  const lift = lying.y - standing.y, lift3 = lying.y - stretched.y;
  expect(Math.abs(lift - expectedLift)).toBeLessThan(3);
  expect(lift3 / lift).toBeGreaterThan(2.4); // three times the height, about three times the lift
  expect(lift3 / lift).toBeLessThan(3.6);
  expect(Math.abs(standing.x - lying.x)).toBeLessThan(3); // straight up, not sideways
  expect(Math.abs(stretched.x - lying.x)).toBeLessThan(4);
  await flat.click();
  expect(Math.abs((await buildingAt()).y - lying.y)).toBeLessThan(2); // and flat again puts it back
});

// Detail that follows the view. `?pcBudget=1000` makes a load read only the top level of the tiny file (625 points), the way a load of a big area reads only
// the coarse levels; then zooming in should read finer levels, but only where the screen is. The file's points are 200 ft apart at the top level, so a node
// is wanted when it is more than 37.5 px across: at zoom 11 (the tile is 50 px) nothing more, at zoom 12 (100 px) level 1 (50 px), at zoom 14 all of it.
const zoomTo = (page: Page, zoom: number, centre = TILE_CENTRE) =>
  page.evaluate(([lonlat, z]) => window.__map!.jumpTo({ center: lonlat as [number, number], zoom: z as number, padding: { left: 0 } }), [centre, zoom] as const);
async function openCoarse(page: Page, zoom = 11) {
  const outside = await openApp(page, { pointClouds: {}, path: '/?pcBudget=1000' });
  await zoomTo(page, zoom); // the tile in the middle of the view: the area a load may cover (4 square miles, 3 km across) is round the middle
  await openCard(page);
  await card(page).getByRole('button', { name: 'Use current view' }).click();
  await expect(status(page)).toContainText(zoom === 11 ? 'On the map: 625 points' : /On the map: [\d,]+ points/);
  return outside;
}

test('zooming in reads finer levels for the screen, from the file, and nothing when nothing finer is wanted', async ({ page }) => {
  const outside = await openCoarse(page);
  await page.waitForTimeout(900); // the tile is 50 px across: level 1 (25 px) is not wanted, so nothing is added
  await expect(status(page)).toContainText('On the map: 625 points');
  const before = outside.pointCloudRequests.length;
  await zoomTo(page, 12); // the tile is 100 px: level 1's four nodes (50 px) are wanted, level 2's (25 px) are not: 625 + 1,875
  await expect(status(page)).toContainText('On the map: 2,500 points');
  await zoomTo(page, 14); // 400 px: everything
  await expect(status(page)).toContainText('On the map: 10,000 points');
  const reads = outside.pointCloudRequests.slice(before);
  expect(reads.length).toBeGreaterThan(3);
  expect(reads.every((r) => /^bytes=\d+-\d+$/.test(r.range ?? ''))).toBe(true); // only range requests, and no second search
  expect(outside.pointCloudRequests.filter((r) => r.method === 'POST')).toHaveLength(2); // the load's Phase 3 and Phase 2 searches; the detail asked for no more
  expect(outside.errors).toEqual([]);
  await page.waitForTimeout(700);
  await expect(status(page)).toContainText('On the map: 10,000 points'); // and it stops there
});

test('a load that is coarser than the screen wants gets its detail without the map having to move', async ({ page }) => {
  await openCoarse(page, 12); // the load reads 625 points; at zoom 12 the screen wants level 1 too
  await expect(status(page)).toContainText('On the map: 2,500 points');
});

test('zoomed in on one part, only that part gets the finer detail', async ({ page }) => {
  await openCoarse(page);
  await zoomTo(page, 12);
  await expect(status(page)).toContainText('On the map: 2,500 points');
  // zoom 19 over the middle of the tile's level-2 node at 1,250-2,500 ft east and north: the screen is about 540 by 350 ft, well inside that node
  await zoomTo(page, 19, gridToLonLat(COPC_TILE.x + 1875, COPC_TILE.y + 1875));
  // the level-2 points of that node: the lattice is 50 ft apart; level 2 is every point that is not level 0 or 1 (make_copc.py)
  let expected = 2500;
  for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) {
    const x = (i + 0.5) * 50, y = (j + 0.5) * 50;
    const level2 = !(i % 2 === 0 && j % 2 === 0);
    if (level2 && x >= 1250 && x < 2500 && y >= 1250 && y < 2500) expected++;
  }
  expect(expected).toBe(2500 + 481);
  await expect(status(page)).toContainText(`On the map: ${expected.toLocaleString('en-US')} points`);
  await page.waitForTimeout(700);
  await expect(status(page)).toContainText(`On the map: ${expected.toLocaleString('en-US')} points`); // not the other level-2 nodes
});

test('"Add detail as you zoom in" can be turned off, and on again', async ({ page }) => {
  await openCoarse(page);
  const follow = card(page).getByRole('checkbox', { name: /Add detail as you zoom in/ });
  await expect(follow).toBeChecked();
  await follow.uncheck();
  await zoomTo(page, 14);
  await page.waitForTimeout(1200);
  await expect(status(page)).toContainText('On the map: 625 points'); // nothing was added
  await follow.check(); // turning it on reads for the screen as it is
  await expect(status(page)).toContainText('On the map: 10,000 points');
});

test('an area drawn on the map: only that ground is loaded, and the count is what the area holds', async ({ page }) => {
  const outside = await open(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Draw an area' }).click();
  await expect(card(page).locator('.pc-prompt')).toContainText('one corner');
  const box = await canvasBox(page);
  await page.mouse.click(box.x + 820, box.y + 300);
  await expect(card(page).locator('.pc-prompt')).toContainText('opposite corner');
  await page.mouse.move(box.x + 900, box.y + 400);
  await expect.poll(() => page.evaluate(() => window.__map!.queryRenderedFeatures({ layers: ['pc-preview-line'] }).length)).toBeGreaterThan(0); // the rectangle follows the pointer
  await page.mouse.click(box.x + 1000, box.y + 520);
  await expect(status(page)).toContainText(/On the map: [\d,]+ points/);
  const polygon = await page.evaluate(([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => { const c = window.__map!.unproject([x!, y!]); return [c.lng, c.lat]; }), [820, 300, 1000, 520] as const);
  const expected = latticeInside(polygon.map(([lon, lat]) => lonLatToGrid(lon!, lat!)));
  expect(expected).toBeGreaterThan(500); // about 180 x 220 px = 675 x 826 m: 2,200 by 2,700 ft is 60 points a side... a real number
  expect(Math.abs(numberIn(await status(page).innerText()) - expected)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.__map!.queryRenderedFeatures({ layers: ['pc-areas-line'] }).length)).toBeGreaterThan(0); // the area is outlined
  await toggle(page).click();
  await page.waitForTimeout(400);
  const seen = await paint(page);
  // the dots fill the rectangle and stop at its edges: the middle of what is painted is the middle of the rectangle, and it is no bigger than a dot or two over
  expect(Math.abs((seen.minX + seen.maxX) / 2 - 910)).toBeLessThan(3);
  expect(Math.abs((seen.minY + seen.maxY) / 2 - 410)).toBeLessThan(3);
  expect(seen.maxX - seen.minX).toBeGreaterThan(180 - 4);
  expect(seen.maxX - seen.minX).toBeLessThan(180 + 20);
  expect(seen.maxY - seen.minY).toBeGreaterThan(220 - 4);
  expect(seen.maxY - seen.minY).toBeLessThan(220 + 20);
  expect(outside.errors).toEqual([]);
});

test('Escape stops choosing an area', async ({ page }) => {
  await open(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Draw an area' }).click();
  await expect(card(page).locator('.pc-prompt')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page).locator('.pc-prompt')).toBeHidden();
  await expect(card(page)).toBeVisible(); // the card stays; only the picking stops
});

test('Clear takes the points off the map', async ({ page }) => {
  await open(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Use current view' }).click();
  await expect(status(page)).toContainText('On the map: 10,000 points');
  const clear = card(page).getByRole('button', { name: 'Clear point cloud' });
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(clear).toBeDisabled();
  await expect(status(page)).toBeEmpty();
  await toggle(page).click();
  await page.waitForTimeout(400);
  expect((await paint(page)).count).toBeLessThan(200); // nothing left but the odd label or outline
});

test('Stop ends a load and keeps what has arrived', async ({ page }) => {
  await open(page, { delayMs: 350 });
  await openCard(page);
  await card(page).getByRole('button', { name: 'Use current view' }).click();
  const stop = card(page).getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible();
  await expect(status(page)).toContainText(/Loading \d+ of 21 blocks/, { timeout: 15_000 });
  await stop.click();
  await expect(stop).toBeHidden();
  await expect(card(page)).toContainText('Stopped');
  await expect(card(page).getByRole('button', { name: 'Use current view' })).toBeEnabled();
});

test('a file server that fails is reported, and leaves the map alone', async ({ page }) => {
  await open(page, { missing: true });
  await openCard(page);
  await card(page).getByRole('button', { name: 'Use current view' }).click();
  await expect(card(page).locator('.pc-error')).toContainText('None of the point-cloud files could be read');
  await expect(card(page).getByRole('button', { name: 'Clear point cloud' })).toBeDisabled();
  await expect(card(page).getByRole('button', { name: 'Use current view' })).toBeEnabled(); // it can be tried again
});

test('where no point cloud is, it says so', async ({ page }) => {
  await openApp(page, { pointClouds: {} });
  await showPlace(page, [-88.6, 37.08], 13); // near Paducah, far from the made-up tile
  await openCard(page);
  await card(page).getByRole('button', { name: 'Use current view' }).click();
  await expect(card(page)).toContainText('No KyFromAbove point cloud covers that area');
});

test('the tool and the drawing tools take turns on the card, and the tool is off in a scene', async ({ page }) => {
  await open(page);
  await openCard(page);
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(card(page)).toBeHidden();
  await expect(page.locator('.draw-bar:not(.pc-bar)')).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.draw-bar:not(.pc-bar)')).toBeHidden();
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await expect(toggle(page)).toBeDisabled();
  await expect(toggle(page)).toHaveAttribute('title', /plain map/);
  await expect(card(page)).toBeHidden();
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await expect(toggle(page)).toBeEnabled();
});

test('a click on the map while choosing an area picks a corner and does not look up photos', async ({ page }) => {
  await open(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Draw an area' }).click();
  const box = await canvasBox(page);
  await page.mouse.click(box.x + 850, box.y + 350);
  await expect(page.locator('#panel .status')).toHaveCount(0); // no lookup was made
});
