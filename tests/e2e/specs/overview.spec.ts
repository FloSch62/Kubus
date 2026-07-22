import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('overview page renders cluster health panels from live data', async ({ page }) => {
  await gotoApp(page);

  for (const heading of ['Node usage', 'Workload health', 'Failing pods']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  // Workload rollup buttons carry live counts.
  await expect(page.getByRole('button', { name: /^Deployments/ }).first()).toBeVisible();

  // The crasher fixture pod surfaces under failing pods with a deep link.
  await expect(
    page.getByRole('link', { name: /Pod\/kubus-e2e\/crasher/ }).first(),
  ).toBeVisible({ timeout: 30_000 });
});
