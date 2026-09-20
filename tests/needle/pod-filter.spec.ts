import { expect, test, type Page } from '@playwright/test';

// Kubernetes is a fixture; Needle's worker, WASM and weights are real.
const pods = [
  { name: 'api-crash', namespace: 'production', phase: 'Running', waiting: 'CrashLoopBackOff' },
  { name: 'api-healthy', namespace: 'production', phase: 'Running' },
  { name: 'dns', namespace: 'kube-system', phase: 'Running' },
].map(({ name, namespace, phase, waiting }) => ({
  apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace, uid: name },
  spec: { containers: [{ name: 'app', image: 'nginx:latest' }] },
  status: {
    phase,
    containerStatuses: [{ name: 'app', ready: !waiting, restartCount: waiting ? 8 : 0, state: waiting ? { waiting: { reason: waiting } } : { running: {} } }],
  },
}));

async function openPods(page: Page) {
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path === '/api/contexts') json = [{ name: 'trial', cluster: 'trial', user: 'test', health: 'connected', active: true, current: true }];
    else if (path.endsWith('/api-resources')) json = [{ group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true, verbs: ['get', 'list', 'watch'] }];
    else if (path.endsWith('/namespaces')) json = ['production', 'kube-system'];
    else if (path.endsWith('/overview/signals')) json = { windowMs: 0, objects: {} };
    else if (path.includes('/metrics')) json = { pods: [], nodes: [] };
    else if (path.includes('/resources/')) json = { items: pods };
    await route.fulfill({ json });
  });
  await page.routeWebSocket('**/ws/watch*', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { op: string; id: string; plural: string };
      if (message.op === 'sub') {
        socket.send(JSON.stringify({ op: 'snapshot', id: message.id, items: message.plural === 'pods' ? pods : [] }));
        socket.send(JSON.stringify({ op: 'status', id: message.id, state: 'live' }));
      }
    });
  });
  await page.goto('/r/core/v1/pods?token=trial');
  await expect(page.getByRole('row').filter({ hasText: 'api-crash' })).toBeVisible();
}

test('real Needle WASM generates, previews and applies a filter without a cloud request', async ({ page, context }, testInfo) => {
  const requests: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  await openPods(page);
  expect(requests.filter((url) => url.includes('/needle/'))).toEqual([]);
  await page.getByRole('button', { name: 'Describe a pod filter', exact: true }).click();
  expect(requests.filter((url) => url.includes('/needle/'))).toEqual([]);
  const dialog = page.getByRole('dialog', { name: 'Describe a pod filter' });
  await dialog.getByRole('textbox').fill('Show crashing pods in production');
  await dialog.getByRole('button', { name: 'Generate filter' }).click();
  await expect(dialog.getByText('/ns:production status:crash', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText(/1 of 3 loaded pods match/)).toBeVisible();
  // Nothing is applied before the explicit button click.
  await expect(page.getByPlaceholder('Search… type / for smart filter')).toHaveValue('');
  await page.screenshot({ path: testInfo.outputPath('needle-preview.png') });
  await dialog.getByRole('button', { name: 'Apply filter' }).click();
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(page.getByPlaceholder('Search… type / for smart filter')).toHaveValue('/ns:production status:crash');
  await expect(page.getByRole('row').filter({ hasText: 'api-crash' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'api-healthy' })).toHaveCount(0);
  expect(requests.some((url) => url.endsWith('/needle/needle.wasm'))).toBe(true);
  expect(requests.some((url) => url.endsWith('/needle/needle3.cact'))).toBe(true);
  expect(requests.filter((url) => new URL(url).origin !== 'http://127.0.0.1:3401')).toEqual([]);
});

test('real model handles independent prompts and refuses unsupported requests', async ({ page }) => {
  await openPods(page);
  await page.getByRole('button', { name: 'Describe a pod filter', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe a pod filter' });
  for (const [prompt, expected] of [
    ['Show pods in namespace kube-system', '/ns:kube-system'],
    ['Show unhealthy pods in namespace production', '/ns:production status:unhealthy'],
    ['Show pending pods', '/status:pending'],
    ['Show running pods in kube-system', '/ns:kube-system status:running'],
    ['Show OOMKilled pods', '/status:oom'],
  ]) {
    await dialog.getByRole('textbox').fill(prompt!);
    await expect(dialog.getByRole('button', { name: 'Apply filter' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Generate filter' }).click();
    await expect(dialog.getByText(expected!, { exact: true })).toBeVisible({ timeout: 60_000 });
  }
  // The last case is a known base-model error: it invents namespace "pods".
  // Our grounding check must refuse it, even though confidence is high.
  for (const prompt of ['Delete all pods', 'What is the weather?', 'Do not show running pods', 'Show unhealthy pods']) {
    await dialog.getByRole('textbox').fill(prompt);
    await dialog.getByRole('button', { name: 'Generate filter' }).click();
    await expect(dialog.getByRole('alert')).toContainText('No supported filter found', { timeout: 60_000 });
    await expect(dialog.getByRole('button', { name: 'Apply filter' })).toBeDisabled();
    await expect(page.getByPlaceholder('Search… type / for smart filter')).toHaveValue('');
  }
});

test('missing assets explain setup and leave ordinary filtering usable', async ({ page, context }) => {
  await context.route('**/needle/needle.wasm', (route) => route.fulfill({ status: 404, body: 'Missing' }));
  await openPods(page);
  await page.getByRole('button', { name: 'Describe a pod filter', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe a pod filter' });
  await dialog.getByRole('textbox').fill('Show crashing pods');
  await dialog.getByRole('button', { name: 'Generate filter' }).click();
  await expect(dialog.getByRole('alert')).toContainText('pnpm setup:needle');
  await expect(dialog.getByRole('button', { name: 'Apply filter' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByPlaceholder('Search… type / for smart filter').fill('/status:crash');
  await expect(page.getByRole('row').filter({ hasText: 'api-healthy' })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'api-crash' })).toBeVisible();
});

test('cancelling a model load discards the request and can be retried', async ({ page, context }) => {
  let release: (() => void) | undefined;
  await context.route('**/needle/needle.wasm', async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    // Terminating the worker cancels this request; it must not be aborted twice.
  });
  await openPods(page);
  await page.getByRole('button', { name: 'Describe a pod filter', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe a pod filter' });
  await dialog.getByRole('textbox').fill('Show crashing pods in production');
  await dialog.getByRole('button', { name: 'Generate filter' }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel request' }).click();
  await expect.poll(() => page.workers().length).toBe(0);
  release!();
  await context.unroute('**/needle/needle.wasm');
  await expect(dialog.getByRole('button', { name: 'Apply filter' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Generate filter' }).click();
  await expect(dialog.getByText('/ns:production status:crash', { exact: true })).toBeVisible({ timeout: 60_000 });
});
