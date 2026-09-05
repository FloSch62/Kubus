import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launchDesktop } from '../helpers/app.js';

test('namespace dropdown receives pointer clicks inside the native title bar', async () => {
  const namespace = 'pointer-click-verified';
  const cert = readFileSync(new URL('../fixtures/localhost.crt', import.meta.url));
  const key = readFileSync(new URL('../fixtures/localhost.key', import.meta.url));
  const api = createServer({ cert, key }, (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (new URL(request.url!, 'https://localhost').searchParams.has('watch')) { response.flushHeaders(); return; }
    const body = request.url?.startsWith('/api/v1/namespaces')
      ? { kind: 'NamespaceList', apiVersion: 'v1', metadata: { resourceVersion: '1' }, items: [namespace, 'default'].map((name) => ({ metadata: { name, uid: name, resourceVersion: '1' } })) }
      : request.url === '/version' ? { gitVersion: 'v1.35.0' }
      : request.url === '/api' ? { versions: ['v1'] }
      : request.url === '/apis' ? { groups: [] }
      : { kind: 'APIResourceList', groupVersion: 'v1', resources: [] };
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = (api.address() as AddressInfo).port;
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ kubeconfig: JSON.stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': 'titlebar', clusters: [{ name: 'test', cluster: { server: `https://127.0.0.1:${port}`, 'certificate-authority-data': cert.toString('base64') } }], users: [{ name: 'test', user: {} }], contexts: [{ name: 'titlebar', context: { cluster: 'test', user: 'test' } }] }) });
    const { page } = app;
    await expect.poll(() => page.visible('input[placeholder="All namespaces"]')).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      const root = document.querySelector('input[placeholder="All namespaces"]')!.closest('.MuiAutocomplete-root')!;
      // Use the native drag property directly: Emotion inserts through CSSOM,
      // where WebKit discards Chromium's unsupported WebkitAppRegion property.
      const style = getComputedStyle(root);
      return (style.getPropertyValue('--electrobun-app-region') || style.getPropertyValue('-webkit-app-region')).trim();
    })).toBe('no-drag');
    await page.click('.MuiAutocomplete-root button[title="Open"]');
    await expect.poll(() => page.visible('[role="listbox"]')).toBe(true);
    await expect.poll(() => page.evaluate((name) => Array.from(document.querySelectorAll('[role="option"]')).some((el) => el.textContent === name), namespace)).toBe(true);
    const selector = await page.evaluate((name) => {
      const option = Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent === name)!;
      return `[id="${option.id}"]`;
    }, namespace);
    await page.click(selector);
    await expect.poll(() => page.evaluate(() => document.querySelector('.MuiAutocomplete-root')?.textContent)).toContain(namespace);
  } finally {
    await app?.close();
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
