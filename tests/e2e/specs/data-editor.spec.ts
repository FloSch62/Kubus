import { expect, test } from '@playwright/test';
import { detailLink, gotoApp } from '../helpers/app.js';
import { kubectl, namespace } from '../helpers/cluster.mjs';

const originalMode = 'production';
const editedMode = 'kubus-e2e-edited';

function setFixtureMode(value: string): void {
  kubectl([
    'patch',
    'configmap',
    'web-config',
    '-n',
    namespace,
    '--type=merge',
    '-p',
    JSON.stringify({ data: { MODE: value } }),
  ]);
}

test.beforeEach(() => setFixtureMode(originalMode));
test.afterEach(() => setFixtureMode(originalMode));

test('edits a ConfigMap value through review, dry-run, and apply', async ({ page }) => {
  await gotoApp(page, detailLink('configmaps', namespace, 'web-config'));
  await expect(page.getByText(`${namespace} / web-config`)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('tab', { name: 'Data' }).click();
  const modeEntry = page.getByRole('button').filter({ hasText: 'MODE' }).filter({ hasText: originalMode }).first();
  await expect(modeEntry).toBeVisible({ timeout: 20_000 });
  await modeEntry.click();

  const value = page.getByRole('textbox', { name: 'Value', exact: true });
  await expect(value).toHaveValue(originalMode);
  await value.fill(editedMode);
  await page.getByRole('button', { name: 'Review & apply' }).click();

  const review = page.getByRole('dialog').filter({ hasText: 'Review changes' });
  await expect(review).toBeVisible();
  await expect(review.getByText('Server dry-run accepted this change.')).toBeVisible({ timeout: 20_000 });

  const apply = review.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();

  await expect(page.getByText('ConfigMap web-config updated')).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    () => kubectl(['get', 'configmap', 'web-config', '-n', namespace, '-o', 'jsonpath={.data.MODE}']).trim(),
    { timeout: 20_000 },
  ).toBe(editedMode);
});
