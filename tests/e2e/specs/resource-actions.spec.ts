import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';
import { kubectl, namespace } from '../helpers/cluster.mjs';

function scaleFixture(replicas: number): void {
  kubectl(['scale', 'deployment/web', '-n', namespace, `--replicas=${replicas}`]);
  kubectl(['rollout', 'status', 'deployment/web', '-n', namespace, '--timeout=180s']);
}

test.beforeEach(() => scaleFixture(2));
test.afterEach(() => scaleFixture(2));

test('scales a Deployment from its row actions and persists the replica count', async ({ page }) => {
  await gotoApp(page, '/r/apps/v1/deployments');

  const row = page.getByRole('row').filter({ hasText: 'web' }).filter({ hasText: namespace });
  await expect(row.first()).toBeVisible({ timeout: 20_000 });
  await row.first().getByRole('button', { name: 'Actions for web' }).click();
  await page.getByRole('menuitem', { name: /Scale/ }).click();

  const dialog = page.getByRole('dialog').filter({ hasText: 'Scale web' });
  await expect(dialog.getByText('Current replicas: 2')).toBeVisible();
  await dialog.getByRole('spinbutton', { name: 'Replicas' }).fill('1');
  await dialog.getByRole('button', { name: 'Scale', exact: true }).click();

  await expect(page.getByText('Scaled web to 1')).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    () => kubectl(['get', 'deployment/web', '-n', namespace, '-o', 'jsonpath={.spec.replicas}']).trim(),
    { timeout: 20_000 },
  ).toBe('1');
});
