import { expect, test } from '@playwright/test';
import { gotoApp, TOKEN } from '../helpers/app.js';
import { namespace } from '../helpers/cluster.mjs';

const auth = { Authorization: `Bearer ${TOKEN}` };

test.beforeEach(async ({ request }) => {
  await request.delete('/api/portforwards', { headers: auth });
});

test.afterEach(async ({ request }) => {
  await request.delete('/api/portforwards', { headers: auth });
});

test('starts, uses, and stops a Service port-forward', async ({ page, request }) => {
  await gotoApp(page, '/r/core/v1/services');

  const service = page.getByRole('row').filter({ hasText: 'web' }).filter({ hasText: namespace });
  await expect(service.first()).toBeVisible({ timeout: 20_000 });
  await service.first().getByRole('button', { name: 'Actions for web' }).click();
  await page.getByRole('menuitem', { name: /Port forward/ }).click();

  const dialog = page.getByRole('dialog').filter({ hasText: 'Port forward — service/web' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('spinbutton', { name: 'Local port' }).fill('');
  await expect(dialog.getByText('Empty — a free port is picked automatically.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText(/Forwarding localhost:\d+ → web:80/)).toBeVisible({ timeout: 20_000 });

  let localPort = 0;
  await expect.poll(
    async () => {
      const response = await request.get('/api/portforwards', { headers: auth });
      const forwards = (await response.json()) as Array<{ localPort: number; state: string }>;
      localPort = forwards[0]?.localPort ?? 0;
      return forwards[0]?.state;
    },
    { timeout: 20_000 },
  ).toBe('active');

  const proxied = await request.get(`http://127.0.0.1:${localPort}`);
  expect(proxied.ok()).toBe(true);
  expect(await proxied.text()).toContain('Welcome to nginx');

  await gotoApp(page, '/forwards');
  const forward = page.getByRole('row').filter({ hasText: `service/${namespace}/web:80` });
  await expect(forward.first()).toContainText('Active', { timeout: 20_000 });
  await forward.first().getByRole('button').last().click();
  await expect(page.getByText('No active forwards')).toBeVisible({ timeout: 20_000 });
});
