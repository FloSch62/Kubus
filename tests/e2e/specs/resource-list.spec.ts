import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('pods list shows fixture workloads with live status', async ({ page }) => {
  await gotoApp(page, '/r/core/v1/pods');

  const logger = page.getByRole('row').filter({ hasText: 'logger' }).filter({ hasText: 'kubus-e2e' });
  await expect(logger.first()).toBeVisible({ timeout: 20_000 });
  await expect(logger.first()).toContainText('Running');

  // The crash-looping fixture reports a failure state, not Running.
  const crasher = page.getByRole('row').filter({ hasText: 'crasher' });
  await expect(crasher.first()).toBeVisible();
  await expect(crasher.first()).toContainText(/Error|CrashLoopBackOff/);
});

test('search filter narrows the grid to matching rows', async ({ page }) => {
  await gotoApp(page, '/r/core/v1/pods');
  await expect(page.getByRole('row').filter({ hasText: 'logger' }).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.getByPlaceholder(/Search…/).fill('logger');

  await expect(page.getByRole('row').filter({ hasText: 'logger' }).first()).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'coredns' })).toHaveCount(0);
});

test('deployments list reports fixture rollout readiness', async ({ page }) => {
  await gotoApp(page, '/r/apps/v1/deployments');

  const web = page.getByRole('row').filter({ hasText: 'web' }).filter({ hasText: 'kubus-e2e' });
  await expect(web.first()).toBeVisible({ timeout: 20_000 });
  await expect(web.first()).toContainText('2/2');
});

test('configmaps list shows fixture data objects', async ({ page }) => {
  await gotoApp(page, '/r/core/v1/configmaps');

  // The grid virtualizes rows, so filter instead of scrolling for the fixture.
  await expect(page.getByRole('row').nth(1)).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder(/Search…/).fill('web-config');

  const row = page.getByRole('row').filter({ hasText: 'web-config' });
  await expect(row.first()).toBeVisible();
  await expect(row.first()).toContainText('kubus-e2e');
});
