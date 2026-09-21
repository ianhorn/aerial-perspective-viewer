import { expect, test, type Page } from '@playwright/test';
import { openApp } from './support.ts';

// The Scene and Photo buttons sit in MapLibre's control group, whose background is white in every colour scheme.
// In a browser in dark mode the Scene button's text went white on white, and MapLibre's own hover rule painted a
// near-white background over the red "on" state, so its text went to 1.1:1. Both were found by eye by the user.

/** WCAG contrast ratio between the text and background colours of an element, as the browser draws them now. */
async function contrast(page: Page, name: string): Promise<number> {
  return page.getByRole('button', { name, exact: true }).evaluate((button) => {
    const rgba = (css: string): number[] => (css.match(/[\d.]+/g) ?? []).map(Number);
    // What is really behind the text: the backgrounds of the button and everything around it, some of them
    // see-through (the button is transparent when off, and MapLibre's hover colour is 5% black), laid over white.
    const layers: number[][] = [];
    for (let node: Element | null = button; node; node = node.parentElement) layers.push(rgba(getComputedStyle(node).backgroundColor));
    let behind = [255, 255, 255];
    for (const [r, g, b, alpha = 1] of layers.reverse()) behind = [r!, g!, b!].map((c, i) => c * alpha + behind[i]! * (1 - alpha));
    const luminance = ([r, g, b]: number[]): number => {
      const [lr, lg, lb] = [r!, g!, b!].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
    };
    const a = luminance(rgba(getComputedStyle(button).color)), b = luminance(behind);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`the Scene and Photo buttons are readable in ${scheme} mode, off, on, and under the pointer`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    const scene = page.getByRole('button', { name: 'Scene', exact: true });

    await page.mouse.move(5, 5);
    expect(await contrast(page, 'Scene')).toBeGreaterThanOrEqual(4.5); // off
    expect(await contrast(page, "Bird's Eye View")).toBeGreaterThanOrEqual(4.5); // pressed while the scene is off
    await page.getByRole('button', { name: "Bird's Eye View", exact: true }).hover();
    expect(await contrast(page, "Bird's Eye View")).toBeGreaterThanOrEqual(4.5); // pressed, pointer on it
    await page.mouse.move(5, 5);
    await scene.hover();
    expect(await contrast(page, 'Scene')).toBeGreaterThanOrEqual(4.5); // off, pointer on it

    await scene.click();
    await expect(scene).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Photo', exact: true })).toBeVisible();
    expect(await contrast(page, 'Scene')).toBeGreaterThanOrEqual(4.5); // on, pointer on it
    await page.mouse.move(5, 5);
    expect(await contrast(page, 'Scene')).toBeGreaterThanOrEqual(4.5); // on
    expect(await contrast(page, 'Photo')).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page, "Bird's Eye View")).toBeGreaterThanOrEqual(4.5); // not pressed while the scene is on
  });
}

test("Bird's Eye View is the plain map: pressed while the scene is off, above Scene, and the same switch", async ({ page }) => {
  await openApp(page);
  const bird = page.getByRole('button', { name: "Bird's Eye View", exact: true });
  const scene = page.getByRole('button', { name: 'Scene', exact: true });
  const photo = page.getByRole('button', { name: 'Photo', exact: true });
  // it sits directly above Scene, in the same group, and is pressed at the start (the map is the plain map)
  const [b, s] = [await bird.boundingBox(), await scene.boundingBox()];
  expect(b!.y + b!.height).toBeLessThanOrEqual(s!.y + 1);
  expect(s!.y - (b!.y + b!.height)).toBeLessThan(4);
  await expect(bird).toHaveAttribute('aria-pressed', 'true');
  await expect(scene).toHaveAttribute('aria-pressed', 'false');
  await expect(photo).toBeHidden();

  await bird.click(); // toggles the scene on, as Scene does
  await expect(scene).toHaveAttribute('aria-pressed', 'true');
  await expect(bird).toHaveAttribute('aria-pressed', 'false');
  await expect(photo).toBeVisible();

  await bird.click(); // and off again
  await expect(scene).toHaveAttribute('aria-pressed', 'false');
  await expect(bird).toHaveAttribute('aria-pressed', 'true');
  await expect(photo).toBeHidden();

  await scene.click(); // Scene flips it too
  await expect(bird).toHaveAttribute('aria-pressed', 'false');
  await scene.click();
  await expect(bird).toHaveAttribute('aria-pressed', 'true');
});
