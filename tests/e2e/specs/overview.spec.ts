import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('overview page renders cluster health panels from live data', async ({ page }) => {
  await gotoApp(page);

  for (const heading of ['Node usage', 'Workload health']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  // Workload rollup buttons carry live counts.
  await expect(page.getByRole('button', { name: /^Deployments/ }).first()).toBeVisible();

  // The overview refreshes every 10s, so allow the live pod state to reach the
  // conditional failing-pods panel and assert against that table specifically.
  await expect(page.getByRole('heading', { name: 'Failing pods' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('row').filter({ hasText: 'kubus-e2e/crasher' })).toBeVisible();
});
