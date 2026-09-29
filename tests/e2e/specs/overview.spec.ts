import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('overview page renders cluster health panels from live data', async ({ page }) => {
  await gotoApp(page);

  for (const heading of ['Needs attention', 'Inventory']) {
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  }

  // Inventory buttons carry live counts and open their lists.
  await expect(page.getByRole('button', { name: /^Deployments/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Pods: \d+ of \d+ running$/ }).first()).toBeVisible();

  // The intentionally crashing fixture produces a warning event with a pod
  // deep link. The failing-pods tile and panel are conditional on a state
  // snapshot and may be absent while Kubernetes transitions between restarts.
  await expect(page.getByRole('heading', { name: 'Warning events (1h)' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: /Pod\/kubus-e2e\/crasher/ }).first()).toBeVisible();
});
