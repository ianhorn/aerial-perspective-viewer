import { expect, test } from '@playwright/test';
import { gridToLonLat } from '../src/lcc.ts';
import { PALETTE } from './fixture-photo.ts';
import { clickPlace, COVERED, groundAtPixel, openApp, paneGeometry, shownFrame } from './support.ts';

// Everything that needs a photo. The bucket serves a made-up photo (fixture-photo.ts): a flat colour in each tile, and a
// flat terrain patch at the synthetic ground height, so these run without the vendor's data or the network.

test('the pane draws the photo, in the colours of its tiles', async ({ page }) => {
  const outside = await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  const canvas = page.locator('#photo .photo-canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('#photo footer .info')).toHaveText(/^Preview at \d+ × \d+ px/);

  // Sample the picture on a grid: every sample is one of the palette's colours (or a blend at a tile's edge), and several colours show.
  const colours = await canvas.evaluate((c: HTMLCanvasElement, palette) => {
    const ctx = c.getContext('2d')!;
    const found = new Set<number>();
    let onPalette = 0, total = 0;
    for (let fy = 0.2; fy < 0.9; fy += 0.1) {
      for (let fx = 0.2; fx < 0.9; fx += 0.1) {
        const [r, g, b] = ctx.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data;
        total++;
        const i = palette.findIndex(([pr, pg, pb]) => Math.abs(pr - r!) <= 3 && Math.abs(pg - g!) <= 3 && Math.abs(pb - b!) <= 3);
        if (i >= 0) { onPalette++; found.add(i); }
      }
    }
    return { onPalette, total, distinct: found.size };
  }, PALETTE as unknown as number[][]);
  expect(colours.onPalette / colours.total).toBeGreaterThan(0.6);
  expect(colours.distinct).toBeGreaterThanOrEqual(3);
  expect(outside.photoRequests.some((r) => r.url.endsWith('.tif'))).toBe(true);
  expect(outside.strays).toEqual([]);
  expect(outside.errors).toEqual([]);
});

test('zooming in reads sharper tiles from the photo, and the view returns to the whole photo with Fit', async ({ page }) => {
  const outside = await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  const canvas = page.locator('#photo .photo-canvas');
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBe(1);
  const before = outside.photoRequests.length;
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80); }
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(4);
  await expect(canvas).toHaveAttribute('data-detail', 'sharp');
  await expect(page.locator('#photo footer .info')).toContainText('sharp detail from the photo');
  expect(outside.photoRequests.length).toBeGreaterThan(before); // tiles were read for the zoomed area

  await page.locator('#photo').getByRole('button', { name: 'Show the whole photo' }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBe(1);
});

test('clicking the photo puts a dot on the map at the ground that pixel sees', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  const frame = await shownFrame(page);
  await expect(page.locator('#photo .photo-canvas')).toBeVisible();
  const pane = await paneGeometry(page, frame.cam);

  // a spot a little off the middle of the photo
  const click = { x: pane.box.x + pane.box.width * 0.55, y: pane.box.y + pane.box.height * 0.62 };
  await page.mouse.click(click.x, click.y);

  const { col, row } = pane.toPixel(click.x, click.y);
  const ground = groundAtPixel(frame.cam, col, row);
  const [lon, lat] = gridToLonLat(ground.x, ground.y);
  // (MapLibre may return the one feature once for each tile it is in, so ask only that there is one.)
  await expect.poll(() => page.evaluate(() => window.__map!.querySourceFeatures('photo-pick').length)).toBeGreaterThanOrEqual(1);
  const dot = await page.evaluate(() => (window.__map!.querySourceFeatures('photo-pick')[0]!.geometry as unknown as { coordinates: number[] }).coordinates);
  // The test finds the clicked pixel from the canvas's rounded zoom attributes (4 decimals, about 1.4 photo pixels), so allow about a metre.
  expect(Math.abs(dot[0]! - lon)).toBeLessThan(1e-5);
  expect(Math.abs(dot[1]! - lat)).toBeLessThan(1e-5);
});

test('the list rows get small pictures of the ground around the clicked point', async ({ page }) => {
  await openApp(page, { photos: 'fixture' });
  await clickPlace(page, COVERED);
  const thumbs = page.locator('#panel .frames .thumb canvas');
  await expect(thumbs).toHaveCount(5, { timeout: 30_000 });
  const size = await thumbs.first().evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  expect(size).toEqual([96, 72]);
});
