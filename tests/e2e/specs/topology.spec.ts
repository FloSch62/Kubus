import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';
import { contextName } from '../helpers/cluster.mjs';

test('double-clicking a card in the Map tab opens that resource', async ({ page }) => {
  const sel = encodeURIComponent(`${contextName}|kubus-e2e|web`);
  await gotoApp(page, `/r/apps/v1/deployments?sel=${sel}`);
  await expect(page.getByText('kubus-e2e / web')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('tab', { name: 'Map' }).click();
  const replicaSet = page.locator('.react-flow__node').filter({ hasText: 'ReplicaSet' }).filter({ hasText: 'web-' }).first();
  await expect(replicaSet).toBeVisible({ timeout: 20_000 });

  // The graph starts locked; double-click must still open, not zoom.
  await replicaSet.dblclick();
  await expect(page.getByText(/^kubus-e2e \/ web-[a-z0-9]+$/)).toBeVisible();
});
