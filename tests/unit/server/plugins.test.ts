import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@kubus/shared';
import type { AppContext } from '../../../server/src/app.js';
import { SettingsStore } from '../../../server/src/settings-store.js';
import { PluginManager } from '../../../server/src/plugins/manager.js';
import { registerPluginRoutes } from '../../../server/src/routes/plugins.js';
import { readPodInterfaces } from '../../../server/src/plugins/pod-interfaces.js';
vi.mock('../../../server/src/plugins/pod-interfaces.js', () => ({ readPodInterfaces: vi.fn().mockResolvedValue([]) }));

const manifest: PluginManifest = {
  apiVersion: 1,
  id: 'test-plugin',
  name: 'Test plugin',
  version: '1.0.0',
  description: 'A test extension',
  author: 'Kubus',
  entry: 'index.html',
  permissions: { resources: [{ group: '', resources: ['pods', 'secrets'] }], actions: ['resource.open'] },
};
let root: string;
let app: ReturnType<typeof Fastify>;
let manager: PluginManager;
let settings: SettingsStore;
const json = vi.fn();
const find = vi.fn();
function bundle(name: string, value: unknown = manifest) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kubus-plugin.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h1>Plugin</h1>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export {};');
  return dir;
}
beforeEach(() => {
  vi.mocked(readPodInterfaces).mockReset().mockResolvedValue([]);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kubus-plugins-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', root);
  app = Fastify();
  settings = new SettingsStore(app.log);
  manager = new PluginManager(settings, path.join(root, 'bundled'));
  find.mockReset().mockResolvedValue({ group: '', version: 'v1', plural: 'pods', kind: 'Pod', namespaced: true });
  json.mockReset().mockResolvedValue({ items: [{ metadata: { name: 'pod', managedFields: [{}] } }], metadata: { continue: 'next-page' } });
  registerPluginRoutes(app, { clusters: { get: () => ({ discovery: { find }, raw: { json } }) } } as unknown as AppContext, manager);
});

describe('plugin interface capability', () => {
  const input = { ctx: 'cluster', group: '', version: 'v1', plural: 'pods', namespace: 'lab', name: 'pod', container: 'device' };
  const request = (payload: unknown = input) => app.inject({ method: 'POST', url: `/api/plugins/${manifest.id}/interfaces`, payload });
  beforeEach(() => {
    manager.install(bundle('source', { ...manifest, permissions: { ...manifest.permissions, actions: ['pod.interfaces'] } }));
    manager.setEnabled(manifest.id, true);
    json.mockResolvedValue({
      metadata: { name: 'pod', uid: 'current-pod' },
      spec: { containers: [{ name: 'device' }], initContainers: [{ name: 'planner' }] },
      status: { containerStatuses: [{ name: 'device', state: { running: {} } }] },
    });
  });
  it('requires an enabled manifest capability and denies arbitrary command inputs', async () => {
    expect((await request({ ...input, command: ['sh'] })).statusCode).toBe(400);
    expect(readPodInterfaces).not.toHaveBeenCalled();
    manager.setEnabled(manifest.id, false);
    expect((await request()).statusCode).toBe(403);
  });
  it('enforces namespace scope and restricts inspection to actual running application containers', async () => {
    expect((await request({ ...input, namespaceScope: ['other'] })).statusCode).toBe(403);
    expect((await request({ ...input, container: 'planner' })).statusCode).toBe(409);
    expect(readPodInterfaces).not.toHaveBeenCalled();
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ podUID: 'current-pod', container: 'device', interfaces: [] });
  });
  it('revokes observations when the plugin is disabled during inspection', async () => {
    vi.mocked(readPodInterfaces).mockImplementation(async () => {
      manager.setEnabled(manifest.id, false);
      return [];
    });
    expect((await request()).statusCode).toBe(403);
  });
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('plugin lifecycle and bundle boundary', () => {
  it('copies a bundle, starts disabled, persists enablement and rejects access after revocation', () => {
    const source = bundle('source');
    manager.install(source);
    expect(manager.list()[0]).toMatchObject({ enabled: false, bundled: false });
    expect(() => manager.asset(manifest.id, 'index.html')).toThrow('disabled');
    manager.setEnabled(manifest.id, true);
    fs.writeFileSync(path.join(source, 'index.html'), 'changed upstream');
    expect(manager.asset(manifest.id, 'index.html').toString()).toContain('<h1>Plugin</h1>');
    expect(new PluginManager(settings, path.join(root, 'bundled')).list()[0]?.enabled).toBe(true);
    manager.setEnabled(manifest.id, false);
    expect(() => manager.asset(manifest.id, 'app.js')).toThrow('disabled');
    manager.remove(manifest.id);
    expect(manager.list()).toEqual([]);
  });
  it.each([
    { ...manifest, apiVersion: 2 },
    { ...manifest, id: '../escape' },
    { ...manifest, entry: '../index.html' },
    { ...manifest, permissions: { ...manifest.permissions, resources: [{ group: '*', resources: ['*'] }] } },
    { ...manifest, permissions: { ...manifest.permissions, actions: ['shell.exec'] } },
  ])('rejects incompatible or overbroad manifests', (invalid) => {
    expect(() => manager.install(bundle('source', invalid))).toThrow('Invalid plugin manifest');
  });
  it('rejects symlinks and traversal even when enabled', () => {
    const source = bundle('source');
    fs.symlinkSync(path.join(source, 'app.js'), path.join(source, 'link.js'));
    expect(() => manager.install(source)).toThrow('Unsupported plugin file');
    fs.unlinkSync(path.join(source, 'link.js'));
    manager.install(source);
    manager.setEnabled(manifest.id, true);
    expect(() => manager.asset(manifest.id, '../settings.json')).toThrow('asset not found');
    expect(() => manager.asset(manifest.id, '..\\settings.json')).toThrow('asset not found');
  });
  it('does not let installed extensions replace or delete bundled plugins', () => {
    bundle('bundled/test-plugin');
    const withBundled = new PluginManager(settings, path.join(root, 'bundled'));
    expect(() => withBundled.install(bundle('source'))).toThrow('already installed');
    expect(() => withBundled.remove(manifest.id)).toThrow('cannot be removed');
    expect(withBundled.list()[0]?.enabled).toBe(false);
  });
  it('survives a broken bundle at startup', () => {
    bundle('bundled/broken', { id: 'broken' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(new PluginManager(settings, path.join(root, 'bundled')).list()).toEqual([]);
    warning.mockRestore();
  });
});

describe('plugin resource API', () => {
  beforeEach(() => {
    manager.install(bundle('source'));
    manager.setEnabled(manifest.id, true);
  });
  const request = (payload: unknown) => app.inject({ method: 'POST', url: `/api/plugins/${manifest.id}/resources`, payload });
  const pod = { ctx: 'cluster', group: '', version: 'v1', plural: 'pods', namespace: 'lab' };
  it('does not infer interface inspection permission from resource reads or navigation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/plugins/${manifest.id}/interfaces`,
      payload: { ...pod, name: 'pod', container: 'device' },
    });
    expect(response.statusCode).toBe(403);
    expect(readPodInterfaces).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
  it('limits reads, removes managed fields, and preserves pagination', async () => {
    const response = await request({ ...pod, continue: 'previous', labelSelector: 'c9s.run/topologyOwner=lab' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ items: [{ metadata: { name: 'pod' } }], continue: 'next-page' });
    expect(json.mock.calls[0]?.[0]).toContain('/api/v1/namespaces/lab/pods?');
    expect(json.mock.calls[0]?.[0]).toContain('limit=500');
  });
  it.each([
    { ...pod, plural: 'configmaps' },
    { ...pod, group: 'apps', plural: 'pods' },
  ])('rejects undeclared resources before touching Kubernetes', async (input) => {
    expect((await request(input)).statusCode).toBe(403);
    expect(json).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });
  it.each([
    { ...pod, plural: '../secrets' },
    { ...pod, namespace: 'a/../b' },
    { ...pod, name: '..' },
    { ...pod, method: 'DELETE' },
    { ...pod, path: '/api/v1/secrets' },
  ])('rejects arbitrary path/method injection', async (input) => {
    expect((await request(input)).statusCode).toBe(400);
    expect(json).not.toHaveBeenCalled();
  });
  it('enforces host namespace filters using discovery without blocking cluster-scoped resources', async () => {
    expect((await request({ ...pod, namespace: undefined, namespaceScope: ['lab'] })).statusCode).toBe(403);
    expect((await request({ ...pod, namespace: 'other', namespaceScope: ['lab'] })).statusCode).toBe(403);
    expect(json).not.toHaveBeenCalled();
    find.mockResolvedValue({ group: '', version: 'v1', plural: 'pods', kind: 'Example', namespaced: false });
    expect((await request({ ...pod, namespace: undefined, namespaceScope: ['lab'] })).statusCode).toBe(200);
  });
  it('blocks raw bundled files from bypassing the CSP route', async () => {
    expect((await app.inject({ url: '/plugin-bundles/test-plugin/index.html' })).statusCode).toBe(404);
  });
  it('redacts Secret values, including plugin reads', async () => {
    json.mockResolvedValue({ metadata: { name: 'secret' }, data: { password: 'never-return' }, stringData: { token: 'never-return' } });
    const response = await request({ ...pod, plural: 'secrets', name: 'secret' });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('never-return');
  });
  it('revokes a response that was already in flight', async () => {
    json.mockImplementation(async () => {
      manager.setEnabled(manifest.id, false);
      return { items: [] };
    });
    expect((await request(pod)).statusCode).toBe(403);
  });
  it('reports unsupported CRDs and refuses missing namespaces for named resources', async () => {
    expect((await request({ ...pod, name: 'x', namespace: undefined })).statusCode).toBe(400);
    find.mockResolvedValue(undefined);
    expect((await request(pod)).statusCode).toBe(404);
  });
  it('serves modules to opaque origins and applies a restrictive sandbox to direct loads', async () => {
    const response = await app.inject({ url: `/plugin-assets/${manifest.id}/app.js` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts;');
    expect(response.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    manager.setEnabled(manifest.id, false);
    expect((await app.inject({ url: `/plugin-assets/${manifest.id}/app.js` })).statusCode).toBe(403);
  });
});
