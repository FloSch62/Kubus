import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test.skip(!existsSync(new URL('../../client/public/needle/cluster-model.json', import.meta.url)), 'Cluster question regression uses the locally trained model.');
const pods = [
  { name: 'api-crash', namespace: 'production', restarts: 12, reason: 'CrashLoopBackOff' },
  { name: 'web', namespace: 'production', restarts: 1, reason: '' },
  { name: 'other', namespace: 'staging', restarts: 99, reason: '' },
].map(({ name, namespace, restarts, reason }) => ({
  kind: 'Pod', metadata: { name, namespace, uid: `${namespace}/${name}` },
  spec: { containers: [{ name: 'app', image: 'nginx:1.28' }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: !reason, restartCount: restarts, state: reason ? { waiting: { reason } } : { running: {} } }] },
}));
async function open(page: Page) {
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path === '/api/contexts') json = [{ name: 'trial', cluster: 'trial', user: 'test', health: 'connected', active: true, current: true }];
    else if (path.endsWith('/api-resources')) json = [{ group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true, verbs: ['get', 'list', 'watch'] }];
    else if (path.endsWith('/namespaces')) json = ['production', 'staging'];
    else if (path.endsWith('/metrics/pods')) json = { available: true, probed: true, items: [
      { name: 'api-crash', namespace: 'production', cpuMilli: 200, memBytes: 104857600 },
      { name: 'web', namespace: 'production', cpuMilli: 100, memBytes: 52428800 },
    ] };
    else if (path.endsWith('/events')) json = { items: [{ metadata: { name: 'event1', namespace: 'production', uid: 'event1' }, type: 'Warning', involvedObject: { name: 'api-crash', kind: 'Pod' }, reason: 'BackOff', message: 'Back-off restarting failed container', lastTimestamp: '2026-09-20T10:00:00Z' }] };
    else if (path.endsWith('/resources/core/v1/pods')) json = { items: pods };
    else if (path.includes('/resources/')) json = { items: [] };
    else if (path.endsWith('/overview/signals')) json = { windowMs: 0, objects: {} };
    await route.fulfill({ json });
  });
  await page.routeWebSocket('**/ws/watch*', (socket) => socket.onMessage((raw) => {
    const message = JSON.parse(String(raw)) as { op: string; id: string; plural: string };
    if (message.op === 'sub') {
      socket.send(JSON.stringify({ op: 'snapshot', id: message.id, items: message.plural === 'pods' ? pods : [] }));
      socket.send(JSON.stringify({ op: 'status', id: message.id, state: 'live' }));
    }
  }));
  await page.goto('/r/core/v1/pods?token=trial');
  await expect(page.getByRole('row').filter({ hasText: 'api-crash' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask your cluster', exact: true }).click();
  return page.getByRole('dialog', { name: 'Ask your cluster' });
}

test('real tuned WASM answers from scoped cluster facts without external requests or mutations', async ({ page, context }, testInfo) => {
  const dialog = await open(page);
  const requests: { url: string; method: string }[] = [];
  context.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  for (const [question, expected] of [
    ['Show pod restart counts in namespace production', '13 recorded container restarts across 2 pods.'],
    ['Show current memory usage in namespace production', '150.0 MiB across 2 sampled pods.'],
    ['Show warning events in namespace production', 'Back-off restarting failed container'],
    ['Show pod images in namespace production', '2 container specifications across 2 pods.'],
  ]) {
    await dialog.getByRole('textbox', { name: 'Question about your cluster' }).fill(question!);
    await dialog.getByRole('button', { name: 'Ask cluster', exact: true }).click();
    await expect(dialog.getByTestId('cluster-answer')).toContainText(expected!, { timeout: 60_000 });
    await expect(dialog.getByTestId('cluster-answer')).toContainText('Namespaces: production');
  }
  await page.screenshot({ path: testInfo.outputPath('cluster-answer.png') });
  // This wording is a measured model error; the boundary refuses the wrong
  // generic inventory instead of presenting it as a restart report.
  await dialog.getByRole('textbox').fill('Which pods restart most in namespace production?');
  await dialog.getByRole('button', { name: 'Ask cluster', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('more specific report', { timeout: 60_000 });
  await expect(dialog.getByTestId('cluster-answer')).toHaveCount(0);
  expect(requests.every(({ url }) => new URL(url).origin === 'http://127.0.0.1:3401')).toBe(true);
  expect(requests.filter(({ url }) => new URL(url).pathname.startsWith('/api/')).every(({ method }) => method === 'GET')).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => page.workers().length).toBe(0);
});

test('unsupported operations and unavailable metrics produce no invented answer', async ({ page }) => {
  const dialog = await open(page);
  await dialog.getByRole('textbox').fill('Delete all pods');
  await dialog.getByRole('button', { name: 'Ask cluster', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('supported cluster question', { timeout: 60_000 });
  await expect(dialog.getByTestId('cluster-answer')).toHaveCount(0);
  await page.route('**/metrics/pods*', (route) => route.fulfill({ json: { available: false, probed: true, items: [] } }));
  await dialog.getByRole('textbox').fill('Show current CPU usage');
  await dialog.getByRole('button', { name: 'Ask cluster', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('metrics are unavailable', { timeout: 60_000 });
  await expect(dialog.getByTestId('cluster-answer')).toHaveCount(0);
});

test('cancelling a cluster read discards its late answer', async ({ page }) => {
  const dialog = await open(page);
  let release: (() => void) | undefined;
  await page.route('**/metrics/pods*', async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { available: true, probed: true, items: [] } }).catch(() => {});
  });
  await dialog.getByRole('textbox').fill('Show current CPU usage');
  await dialog.getByRole('button', { name: 'Ask cluster', exact: true }).click();
  await expect.poll(() => Boolean(release), { timeout: 60_000 }).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel request' }).click();
  release!();
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(dialog.getByTestId('cluster-answer')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Ask cluster', exact: true })).toBeEnabled();
});
