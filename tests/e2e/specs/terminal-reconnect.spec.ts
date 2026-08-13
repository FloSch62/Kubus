import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';
import { namespace } from '../helpers/cluster.mjs';

test('reconnects a terminal session from its tab menu', async ({ page }) => {
  let execSocketCount = 0;
  let closedExecSocketCount = 0;
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/ws/exec?')) return;
    execSocketCount += 1;
    socket.on('close', () => {
      closedExecSocketCount += 1;
    });
  });

  await gotoApp(page, '/r/core/v1/pods');
  const row = page.getByRole('row').filter({ hasText: 'logger' }).filter({ hasText: namespace }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Shell' }).click();

  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => execSocketCount).toBe(1);

  await page.getByRole('tab', { name: /sh: logger/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reconnect' }).click();

  await expect.poll(() => execSocketCount).toBe(2);
  await expect.poll(() => closedExecSocketCount).toBe(1);
  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveCount(1);
});
