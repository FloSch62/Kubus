import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('namespaces list includes the fixture namespace', async ({ page }) => {
  await gotoApp(page, '/r/core/v1/namespaces');

  const row = page.getByRole('row').filter({ hasText: 'kubus-e2e' });
  await expect(row.first()).toBeVisible({ timeout: 20_000 });
  await expect(row.first()).toContainText('Active');
});

test('events page loads live cluster events', async ({ page }) => {
  await gotoApp(page, '/events');

  // The crasher fixture reliably produces BackOff warning events.
  await expect(page.getByText('BackOff').first()).toBeVisible({ timeout: 30_000 });
});

test('helm page renders without a release selected', async ({ page }) => {
  await gotoApp(page, '/helm');

  await expect(page.getByRole('link', { name: 'Helm Releases' })).toBeVisible();
  // The page shell must render even if the cluster has no releases (CI).
  await expect(page.locator('#root')).not.toHaveText(/something went wrong/i);
});
