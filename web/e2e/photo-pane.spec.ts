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
