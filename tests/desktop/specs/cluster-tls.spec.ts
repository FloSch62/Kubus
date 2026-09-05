import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launchDesktop } from '../helpers/app.js';

// Public, test-only credentials for an isolated loopback API. Requiring mTLS
// catches Bun's networking substitutes silently dropping a kubeconfig identity.
test('the packaged server honors Kubernetes CA and client certificates', async () => {
  const cert = readFileSync(new URL('../fixtures/localhost.crt', import.meta.url));
  const key = readFileSync(new URL('../fixtures/localhost.key', import.meta.url));
  let authenticated = 0;
  const api = createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, (request, response) => {
    if (request.url === '/version') authenticated++;
    response.setHeader('content-type', 'application/json');
    const body = request.url === '/version' ? { gitVersion: 'v1.35.0' }
      : request.url === '/api' ? { versions: ['v1'] }
      : request.url === '/apis' ? { groups: [] }
      : { kind: 'APIResourceList', groupVersion: 'v1', resources: [] };
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = (api.address() as AddressInfo).port;
  const config = {
    apiVersion: 'v1', kind: 'Config', 'current-context': '',
    clusters: [{ name: 'tls', cluster: { server: `https://127.0.0.1:${port}`, 'certificate-authority-data': cert.toString('base64') } }],
    users: [{ name: 'tls', user: { 'client-certificate-data': cert.toString('base64'), 'client-key-data': key.toString('base64') } }],
    contexts: [{ name: 'tls', context: { cluster: 'tls', user: 'tls' } }],
  };
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ kubeconfig: JSON.stringify(config) });
    const page = app.page;
    await expect.poll(() => page.evaluate(async () => {
      const response = await fetch('/api/contexts', { headers: { authorization: `Bearer ${sessionStorage.getItem('kubus-token')}` } });
      const contexts = await response.json();
      return contexts.find((context: { name: string }) => context.name === 'tls');
    })).toMatchObject({ health: 'connected', kubernetesVersion: 'v1.35.0' });
    expect(authenticated).toBeGreaterThan(0);
  } finally {
    await app?.close();
    api.closeAllConnections();
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});
