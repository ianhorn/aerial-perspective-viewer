import { expect, test } from '@playwright/test';
import { clickPlace, COVERED, openApp } from './support.ts';

// The photo pane. The invented frames have no photos, so the bucket refuses (openApp) and these tests cover the pane
// around the picture: it opens, names the photo, says when the photo cannot be read, and closes.

test('choosing a photo opens the pane with its name, and a refused photo offers Try again', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  const pane = page.locator('#photo');
  await expect(pane).toBeVisible();
  const first = await page.locator('#panel .frames .frame').first().locator('strong').textContent();
  await expect(pane.locator('h2')).toHaveText(first!);
  await expect(pane.locator('.name')).toHaveText(/^KY_KYAPED_2024_Season1_3IN\/(Fwd|Bwd)_70\d\d_\d+\.tif$/);
  await expect(pane.locator('.message')).toContainText('The photo could not be loaded.');
  await expect(pane.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('Escape and Close hide the pane, and choosing a photo opens it again', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  const pane = page.locator('#photo');
  await expect(pane).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(pane).toBeHidden();

  await page.locator('#panel .frames .frame').nth(1).click();
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Close the photo' }).click();
  await expect(pane).toBeHidden();
});

test('Tuck shrinks the pane to a tab, and the tab opens it again', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  const pane = page.locator('#photo');
  await expect(pane).toBeVisible();
  const wide = (await pane.boundingBox())!.width;

  await pane.getByRole('button', { name: 'Tuck the photo to the side' }).click();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBeLessThan(wide / 4);
  await pane.getByRole('button', { name: 'Open the photo' }).click();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(wide * 0.9);
});

test('Try again asks for the photo again', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  const pane = page.locator('#photo');
  await expect(pane.getByRole('button', { name: 'Try again' })).toBeVisible();
  const asked = page.waitForRequest((request) => request.url().startsWith('https://images.e2e.test/'));
  await pane.getByRole('button', { name: 'Try again' }).click();
  await asked;
  await expect(pane.locator('.message')).toContainText('The photo could not be loaded.'); // refused again, and still not stuck
});

// The measuring tools. Measuring itself needs a photo to click on, which the invented frames do not have (see
// CLAUDE.md, CI); what can be checked here is the toolbar, the choice of tool, and Escape and Backspace.

const TOOL_NAMES = ['Distance', 'Distance 3D', 'Area', 'Area 3D', 'Height', 'Surface location', 'Location 3D'];

test('the pane has the seven measuring tools, none on, and the readout is hidden until one is', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  const pane = page.locator('#photo');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.measure-tools button')).toHaveText(TOOL_NAMES);
  for (const name of TOOL_NAMES) await expect(pane.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(pane.locator('.measure-readout')).toBeHidden();
});

test('choosing a tool turns it on and says what to click; choosing it again, or another, changes that', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  const pane = page.locator('#photo');
  const readout = pane.locator('.measure-readout');

  await pane.getByRole('button', { name: 'Height', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Height', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(readout).toContainText('Click the bottom of the thing on the ground, then its top.');
  await expect(readout.getByRole('button', { name: 'Undo' })).toBeDisabled(); // nothing picked yet
  await expect(readout.getByRole('button', { name: 'Clear' })).toBeDisabled();

  await pane.getByRole('button', { name: 'Area 3D', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Height', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(pane.getByRole('button', { name: 'Area 3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(readout).toContainText('Click the corners of the area to measure the surface of the ground');

  await pane.getByRole('button', { name: 'Area 3D', exact: true }).click(); // the tool that is on, again: off
  await expect(pane.getByRole('button', { name: 'Area 3D', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(readout).toBeHidden();
});

test('turning a tool on does not move or resize the photo (the readout floats over it)', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  const stage = page.locator('#photo .stage');
  const before = await stage.boundingBox();
  await page.locator('#photo').getByRole('button', { name: 'Distance', exact: true }).click();
  await expect(page.locator('#photo .measure-readout')).toBeVisible();
  expect(await stage.boundingBox()).toEqual(before);
});

test('Escape turns the tool off first and only then closes the pane', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, COVERED);
  const pane = page.locator('#photo');
  await pane.getByRole('button', { name: 'Distance', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(pane.getByRole('button', { name: 'Distance', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(pane).toBeVisible(); // that Escape was used up by the tool
  await page.keyboard.press('Escape');
  await expect(pane).toBeHidden();
});
