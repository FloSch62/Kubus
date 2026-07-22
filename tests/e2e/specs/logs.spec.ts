import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('selecting a pod streams its live logs', async ({ page }) => {
  await gotoApp(page, '/r/core/v1/pods');

  const row = page.getByRole('row').filter({ hasText: 'logger' }).filter({ hasText: 'kubus-e2e' });
  await expect(row.first()).toBeVisible({ timeout: 20_000 });
  await row.first().getByRole('checkbox').check();

  await page.getByRole('button', { name: /^Logs/ }).click();

  // The fixture pod emits a numbered line every 2s over the log socket.
  await expect(page.getByText('kubus-e2e log line').first()).toBeVisible({ timeout: 30_000 });
});
