import { expect, test, type Page } from '@playwright/test';
import { SETTINGS_KEY } from '../src/settings.ts';
import { clickPlace, COVERED, openApp, DRAW_BAR } from './support.ts';

// The settings card: what is on it, that a change shows at once and is kept, and that it takes turns with the other cards.

const button = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true });
const card = (page: Page) => page.locator('.settings-bar');
const slider = (page: Page, label: string) => card(page).getByRole('slider', { name: label });
const saved = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as { values: Record<string, number> } | null, SETTINGS_KEY);

async function open(page: Page): Promise<void> {
  await openApp(page);
  await button(page).click();
  await expect(card(page)).toBeVisible();
}

test('the Settings button opens a card with every setting, its value and what it does', async ({ page }) => {
  await openApp(page);
  await expect(card(page)).toBeHidden();
  await button(page).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.settings-group')).toHaveText(['Point cloud', 'Photos']);
  await expect(card(page).getByRole('slider')).toHaveCount(10);
  await expect(card(page).locator('.settings-hint')).toHaveCount(10);
  await expect(slider(page, 'Largest area per load')).toHaveValue('4');
  await expect(card(page).locator('.settings-value').first()).toHaveText('4 square miles');
  await expect(slider(page, 'Photos added at a time')).toHaveValue('5');
  await expect(card(page).getByRole('button', { name: 'Reset all to the defaults' })).toBeDisabled(); // nothing to put back
  await button(page).click();
  await expect(card(page)).toBeHidden();
});

test('a change shows at once, can be put back one at a time or all together, and is kept across a reload', async ({ page }) => {
  await open(page);
  const areaValue = card(page).locator('.settings-row').filter({ has: page.getByRole('slider', { name: 'Largest area per load' }) }).locator('.settings-value');
  const undo = card(page).getByRole('button', { name: 'Reset Largest area per load' });
  await expect(undo).toBeHidden(); // at the default
  await slider(page, 'Largest area per load').fill('2');
  await expect(areaValue).toHaveText('2 square miles');
  await expect(undo).toBeVisible();
  await slider(page, 'Space between points, zoomed in').fill('5.5');
  await expect.poll(() => saved(page)).toEqual({ version: 1, values: { pcAreaSqMi: 2, pcTargetPx: 5.5 } }); // only what differs from the default

  await page.reload();
  await page.waitForFunction(() => window.__map?.getLayer('frame-fill') !== undefined);
  await button(page).click();
  await expect(slider(page, 'Largest area per load')).toHaveValue('2');
  await expect(slider(page, 'Space between points, zoomed in')).toHaveValue('5.5');

  await undo.click();
  await expect(slider(page, 'Largest area per load')).toHaveValue('4');
  await expect(undo).toBeHidden();
  await expect.poll(() => saved(page)).toEqual({ version: 1, values: { pcTargetPx: 5.5 } });
  await card(page).getByRole('button', { name: 'Reset all to the defaults' }).click();
  await expect(slider(page, 'Space between points, zoomed in')).toHaveValue('3');
  await expect.poll(() => saved(page)).toEqual({ version: 1, values: {} });
  await expect(card(page).getByRole('button', { name: 'Reset all to the defaults' })).toBeDisabled();
});

test('the photo list adds as many photos as the setting says', async ({ page }) => {
  await open(page);
  await slider(page, 'Photos added at a time').fill('7');
  await button(page).click();
  await clickPlace(page, COVERED);
  await expect(page.locator('#panel .frames > li:not(.more)')).toHaveCount(7);
  await expect(page.locator('#panel .more-button')).toContainText('Show 7 more');
});

test('the card takes turns with the drawing card and the point cloud card', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(card(page)).toBeHidden();
  await expect(page.locator(DRAW_BAR)).toBeVisible();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'false');
  await button(page).click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator(DRAW_BAR)).toBeHidden();
  await page.getByRole('button', { name: 'Point cloud', exact: true }).click();
  await expect(card(page)).toBeHidden();
  await expect(page.locator('.pc-bar')).toBeVisible();
  await button(page).click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.pc-bar')).toBeHidden();
});

test('a browser that will not keep settings still applies them for the visit', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
  const outside = await openApp(page);
  await button(page).click();
  await slider(page, 'Photos added at a time').fill('8');
  await expect(card(page).locator('.settings-value').last()).toHaveText('8');
  expect(outside.errors).toEqual([]);
});
