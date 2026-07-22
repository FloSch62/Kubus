import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('serves the client shell and rejects unauthenticated API access', async ({ request }) => {
  const shell = await request.get('/');
  expect(shell.ok()).toBe(true);
  expect(await shell.text()).toContain('<div id="root">');

  const noToken = await request.get('/api/contexts');
  expect(noToken.status()).toBe(401);

  const badToken = await request.get('/api/contexts', {
    headers: { Authorization: 'Bearer wrong' },
  });
  expect(badToken.status()).toBe(401);
});

test('lists kubeconfig contexts with health over the API', async ({ request }) => {
  const res = await request.get('/api/contexts', {
    headers: { Authorization: 'Bearer dev' },
  });
  expect(res.ok()).toBe(true);
  const contexts = (await res.json()) as Array<Record<string, unknown>>;

  const kind = contexts.find((c) => c.name === 'kind-kubus-a');
  expect(kind?.current).toBe(true);
  expect(kind?.health).toBe('connected');

  const ghost = contexts.find((c) => c.name === 'kubus-ghost');
  expect(ghost?.health).toBe('error');
});

test('boots the app shell and auto-connects the current context', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await gotoApp(page);
  await expect(page).toHaveTitle('Kubus');

  // Sidebar navigation is present.
  for (const label of ['Overview', 'Events', 'Topology', 'Helm Releases', 'Pods']) {
    await expect(page.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
  }

  // The kubeconfig's current context is connected and shown in the switcher.
  await expect(page.getByRole('button', { name: 'kind-kubus-a' })).toBeVisible();

  // The token was captured and stripped from the address bar.
  await expect(page).not.toHaveURL(/token=/);

  expect(errors).toEqual([]);
});

test('cluster switcher lists every context including unreachable ones', async ({ page }) => {
  await gotoApp(page);
  await page.getByRole('button', { name: 'kind-kubus-a' }).click();

  const search = page.getByPlaceholder('Search contexts…');
  await expect(search).toBeVisible();
  await expect(page.getByText('kubus-ghost')).toBeVisible();

  // Search narrows the list (the ghost row shows its unreachable server URL).
  await search.fill('ghost');
  await expect(page.getByText('kubus-ghost')).toBeVisible();
  await expect(page.getByText('https://127.0.0.1:59999')).toBeVisible();
  await expect(page.getByText(/v1\.\d+\.\d+/)).toHaveCount(0);
});
