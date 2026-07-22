import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('command palette opens with mod+k and closes with escape', async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByRole('button', { name: 'kind-kubus-a' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByPlaceholder(/Search resources, pages, kinds/);
  await expect(palette).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('g-sequences jump between pages', async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByRole('button', { name: 'kind-kubus-a' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/r\/core\/v1\/pods/);

  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page).toHaveURL(/\/helm/);

  await page.keyboard.press('g');
  await page.keyboard.press('o');
  await expect(page).toHaveURL(/\/$/);
});
