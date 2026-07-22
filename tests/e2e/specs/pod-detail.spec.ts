import { expect, test } from '@playwright/test';
import { detailLink, gotoApp } from '../helpers/app.js';

test('pod detail drawer opens from a row click and deep-links via ?sel=', async ({ page }) => {
  await gotoApp(page, '/r/core/v1/pods');
  const row = page.getByRole('row').filter({ hasText: 'logger' }).filter({ hasText: 'kubus-e2e' });
  await expect(row.first()).toBeVisible({ timeout: 20_000 });
  await row.first().getByRole('gridcell').nth(1).click();

  await expect(page.getByText('kubus-e2e / logger')).toBeVisible();
  await expect(page).toHaveURL(/sel=kind-kubus-a%7Ckubus-e2e%7Clogger/);

  // Live pod facts from the cluster.
  await expect(page.getByText('Ready 1/1')).toBeVisible();
  await expect(page.getByText('busybox:1.37')).toBeVisible();
});

test('detail deep link restores the drawer on load', async ({ page }) => {
  await gotoApp(page, detailLink('pods', 'kubus-e2e', 'logger'));

  await expect(page.getByText('kubus-e2e / logger')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('tab', { name: 'YAML' })).toBeVisible();
});

test('YAML tab renders the live manifest in the editor', async ({ page }) => {
  await gotoApp(page, detailLink('pods', 'kubus-e2e', 'logger'));
  await expect(page.getByText('kubus-e2e / logger')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('tab', { name: 'YAML' }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 });
});

test('secret values are not exposed in the detail drawer', async ({ page }) => {
  await gotoApp(page, detailLink('secrets', 'kubus-e2e', 'web-secret'));

  await expect(page.getByText('kubus-e2e / web-secret')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('API_KEY')).toBeVisible();
  // The server redacts secret data; the plaintext must never reach the DOM.
  await expect(page.getByText('super-secret-value')).toHaveCount(0);
});
