import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { ResourceKindInfo } from '@kubus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../server/src/app';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { registerAppRoutes } from '../../../server/src/routes/app';
import { registerContextRoutes } from '../../../server/src/routes/contexts';
import { registerPortForwardRoutes } from '../../../server/src/routes/portforward';
import { registerSchemaRoutes } from '../../../server/src/routes/schema';
import { registerSearchRoutes } from '../../../server/src/routes/search';
import { registerSettingsRoutes } from '../../../server/src/routes/settings';
import { registerSshRoutes } from '../../../server/src/routes/ssh';
import { HttpProblem } from '../../../server/src/util/errors';

const tempDirs: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];

function kubeconfig(contextName = 'kind-a', plugin?: string): string {
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '  - name: cluster-a',
    '    cluster:',
    '      server: https://127.0.0.1:6443',
    'users:',
    '  - name: user-a',
    '    user:',
    ...(plugin ? ['      exec:', '        apiVersion: client.authentication.k8s.io/v1', `        command: ${plugin}`] : ['      token: token']),
    'contexts:',
    `  - name: ${contextName}`,
    '    context:',
    '      cluster: cluster-a',
    '      user: user-a',
    `current-context: ${contextName}`,
    '',
  ].join('\n');
}

function tempKubeconfig(contents = kubeconfig()): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubus-routes-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, contents);
  return file;
}

function resourceKind(overrides: Partial<ResourceKindInfo> = {}): ResourceKindInfo {
  return {
    group: 'apps',
    version: 'v1',
    kind: 'Deployment',
    plural: 'deployments',
    namespaced: true,
    verbs: ['get', 'list'],
    shortNames: ['deploy'],
    ...overrides,
  };
}

interface MockFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function createHarness() {
  const namespaceRelease = vi.fn();
  const namespaceWatcher = {
    ready: vi.fn(async () => {}),
    items: vi.fn(() => [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'zeta' } },
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'alpha' } },
    ]),
  };
  const rawJson = vi.fn(async (requestPath: string) => {
    if (requestPath === '/openapi/v3') return { paths: { 'apis/apps/v1': { serverRelativeURL: '/openapi/apps-v1-hash' } } };
    if (requestPath === '/openapi/apps-v1-hash') {
      return {
        components: {
          schemas: {
            Deployment: {
              type: 'object',
              'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
              properties: { spec: { $ref: '#/components/schemas/DeploymentSpec' } },
            },
            DeploymentSpec: {
              type: 'object',
              properties: {
                replicas: { type: 'integer' },
                template: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true, properties: { anything: {} } },
              },
            },
            Unused: { type: 'string' },
          },
        },
      };
    }
    if (requestPath.includes('/events?')) return { items: [{ metadata: { name: 'event-1' } }] };
    return {};
  });
  const kinds = [
    resourceKind(),
    resourceKind({ group: '', version: 'v1', kind: 'Pod', plural: 'pods', shortNames: ['po'] }),
    resourceKind({ group: 'argoproj.io', version: 'v1alpha1', kind: 'Application', plural: 'applications', custom: true }),
  ];
  const entries = [
    {
      kind: kinds[0],
      name: 'web-api',
      namespace: 'production',
      uid: 'web-uid',
      labelsText: 'app=web tier=backend',
    },
    { kind: kinds[1], name: 'worker-0', namespace: 'jobs', uid: 'worker-uid' },
  ];
  const handle = {
    contextName: 'kind-a',
    raw: { json: rawJson },
    discovery: { getResources: vi.fn(async () => kinds) },
    searchIndex: { entries: vi.fn(async () => entries) },
    watchers: { acquire: vi.fn(() => ({ watcher: namespaceWatcher, release: namespaceRelease })) },
  } as unknown as ClusterHandle;

  const contexts = [{ name: 'kind-a', cluster: 'cluster-a', user: 'user-a', current: true, health: 'connected', active: true }];
  const clusters = {
    listContexts: vi.fn(() => contexts),
    test: vi.fn(async (name: string) => ({ health: 'connected', kubernetesVersion: `v1.30-${name}` })),
    getClusterCa: vi.fn(() => 'PEM'),
    editCluster: vi.fn(),
    setSshHost: vi.fn(),
    removeContext: vi.fn(),
    connect: vi.fn(async () => handle),
    disconnect: vi.fn(),
    reconnect: vi.fn(async () => handle),
    get: vi.fn((name: string) => {
      if (name === 'bad') throw new HttpProblem(409, 'not connected', 'NotConnected');
      return handle;
    }),
    getKubeconfigOverride: vi.fn(() => '/cli/config'),
    getKubeconfigPaths: vi.fn(() => ['/cli/config']),
    primaryKubeconfigPath: vi.fn((): string | null => '/cli/config'),
    setKubeconfigOverride: vi.fn(),
    reload: vi.fn(),
  };
  const settingsState: { kubeconfigPath?: string } = {};
  const settings = {
    load: vi.fn(() => settingsState),
    save: vi.fn((next: { kubeconfigPath?: string }) => Object.assign(settingsState, next)),
  };
  const portForwards = {
    list: vi.fn(() => [{ id: 'pf-1' }]),
    isLocalPortFree: vi.fn(async (port: number) => port !== 8080),
    preflight: vi.fn(async () => ({ allowed: true })),
    start: vi.fn(async (_ctx: string, body: unknown) => ({ id: 'pf-new', ...Object(body) })),
    stopAll: vi.fn(),
    stop: vi.fn((id: string) => {
      if (id === 'missing') throw new HttpProblem(404, 'forward not found', 'NotFound');
    }),
  };
  const sshTunnels = {
    binaryInfo: vi.fn(async () => ({ available: true, version: 'OpenSSH_9.9' })),
  };
  const ctx = {
    config: { token: 'test', port: 0, host: '127.0.0.1', prettyLogs: false },
    clusters,
    settings,
    portForwards,
    sshTunnels,
    cliKubeconfig: '/cli/config',
  } as unknown as AppContext;
  return {
    ctx,
    handle,
    rawJson,
    clusters,
    settings,
    settingsState,
    portForwards,
    sshTunnels,
    namespaceWatcher,
    namespaceRelease,
  };
}

async function buildApp(harness: ReturnType<typeof createHarness>) {
  const app = Fastify();
  apps.push(app);
  registerAppRoutes(app, harness.ctx);
  registerContextRoutes(app, harness.ctx);
  registerPortForwardRoutes(app, harness.ctx);
  registerSchemaRoutes(app, harness.ctx);
  registerSearchRoutes(app, harness.ctx);
  registerSettingsRoutes(app, harness.ctx);
  registerSshRoutes(app, harness.ctx);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('context routes', () => {
  it('lists, probes, returns CAs, connects, reconnects, disconnects, and deletes contexts', async () => {
    const harness = createHarness();
    const app = await buildApp(harness);
    expect((await app.inject({ method: 'GET', url: '/api/contexts' })).json()).toEqual(harness.clusters.listContexts());
    expect((await app.inject({ method: 'POST', url: '/api/contexts/kind-a/test' })).json()).toEqual({
      health: 'connected',
      kubernetesVersion: 'v1.30-kind-a',
    });
    expect((await app.inject({ method: 'GET', url: '/api/contexts/kind-a/ca' })).json()).toEqual({ pem: 'PEM' });

    expect((await app.inject({ method: 'POST', url: '/api/contexts/kind-a/connect' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/contexts/kind-a/connect' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/contexts/kind-a/reconnect' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/contexts/kind-a' })).statusCode).toBe(200);
    expect(harness.clusters.connect).toHaveBeenCalledWith('kind-a');
    expect(harness.clusters.disconnect).toHaveBeenCalledWith('kind-a');
    expect(harness.clusters.reconnect).toHaveBeenCalledWith('kind-a');
    expect(harness.clusters.removeContext).toHaveBeenCalledWith('kind-a');
  });

  it('validates and applies full cluster edits and optional SSH mappings', async () => {
    const harness = createHarness();
    const app = await buildApp(harness);
    const valid = {
      server: ' https://cluster.example.com ',
      skipTlsVerify: false,
      caPem: '',
      proxyUrl: '',
      sshHost: ' jump-host ',
      tlsServerName: '',
      auth: { method: 'token', token: 'secret' },
    };
    const response = await app.inject({ method: 'PUT', url: '/api/contexts/kind-a/cluster', payload: valid });
    expect(response.statusCode).toBe(200);
    expect(harness.clusters.editCluster).toHaveBeenCalledWith('kind-a', {
      server: 'https://cluster.example.com',
      skipTlsVerify: false,
      caPem: null,
      proxyUrl: null,
      tlsServerName: null,
      auth: { method: 'token', token: 'secret' },
    });
    expect(harness.clusters.setSshHost).toHaveBeenCalledWith('kind-a', 'jump-host');

    const keep = await app.inject({
      method: 'PUT',
      url: '/api/contexts/kind-a/cluster',
      payload: { ...valid, sshHost: undefined, auth: { method: 'keep' } },
    });
    expect(keep.statusCode).toBe(200);
    expect(harness.clusters.setSshHost).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, 'expected string'],
    [{ server: 'cluster', skipTlsVerify: false, caPem: null, proxyUrl: null, auth: { method: 'keep' } }, 'API server URL'],
    [
      {
        server: 'https://x',
        skipTlsVerify: false,
        caPem: null,
        proxyUrl: 'http://proxy',
        sshHost: 'jump',
        tlsServerName: null,
        auth: { method: 'keep' },
      },
      'choose either',
    ],
    [
      {
        server: 'https://x',
        skipTlsVerify: false,
        caPem: null,
        proxyUrl: null,
        tlsServerName: null,
        auth: { method: 'token', token: '' },
      },
      'token is required',
    ],
  ])('rejects invalid cluster edit %#', async (payload, message) => {
    const app = await buildApp(createHarness());
    const response = await app.inject({ method: 'PUT', url: '/api/contexts/kind-a/cluster', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain(message);
  });

  it('validates standalone SSH host updates', async () => {
    const harness = createHarness();
    const app = await buildApp(harness);
    expect((await app.inject({ method: 'PUT', url: '/api/contexts/kind-a/ssh-host', payload: { sshHost: '' } })).statusCode).toBe(200);
    expect(harness.clusters.setSshHost).toHaveBeenCalledWith('kind-a', null);
    const invalid = await app.inject({ method: 'PUT', url: '/api/contexts/kind-a/ssh-host', payload: { sshHost: '-bad host' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('returns discovery, sorted watched namespaces, and filtered events', async () => {
    const harness = createHarness();
    const app = await buildApp(harness);
    const discovery = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/api-resources' });
    expect(discovery.json()).toHaveLength(3);
    const namespaces = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/namespaces' });
    expect(namespaces.json()).toEqual(['alpha', 'zeta']);
    expect(harness.namespaceRelease).toHaveBeenCalled();

    const events = await app.inject({
      method: 'GET',
      url: '/api/contexts/kind-a/events?namespace=apps&involvedName=web-0&involvedKind=Pod',
    });
    expect(events.json()).toEqual({ items: [{ metadata: { name: 'event-1' } }] });
    expect(harness.rawJson.mock.calls.at(-1)?.[0]).toContain('/api/v1/namespaces/apps/events?fieldSelector=');
    expect(harness.rawJson.mock.calls.at(-1)?.[0]).toContain('involvedObject.name%3Dweb-0');

    await app.inject({ method: 'GET', url: '/api/contexts/kind-a/events' });
    expect(harness.rawJson.mock.calls.at(-1)?.[0]).toBe('/api/v1/events?');
  });

  it('releases namespace watchers on failure and maps cluster errors', async () => {
    const harness = createHarness();
    harness.namespaceWatcher.ready.mockRejectedValueOnce(new Error('watch denied'));
    const app = await buildApp(harness);
    const failed = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/namespaces' });
    expect(failed.statusCode).toBe(500);
    expect(harness.namespaceRelease).toHaveBeenCalled();
    const bad = await app.inject({ method: 'GET', url: '/api/contexts/bad/api-resources' });
    expect(bad.statusCode).toBe(409);
  });
});

describe('search routes', () => {
  it.each([
    ['deploy', 'kind', 'Deployment'],
    ['web api', 'resource', 'Deployment/web-api'],
    ['webapi', 'resource', 'Deployment/web-api'],
    ['tier backend', 'resource', 'Deployment/web-api'],
    ['health dash', 'page', 'Overview'],
    ['ploy', 'kind', 'Deployment'],
  ])('scores %s across kinds, resources, pages, compact text, and ordered tokens', async (query, resultKind, title) => {
    const app = await buildApp(createHarness());
    const response = await app.inject({ method: 'GET', url: `/api/contexts/kind-a/search?q=${encodeURIComponent(query)}&limit=30` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toContainEqual(expect.objectContaining({ kind: resultKind, title }));
  });

  it('sorts empty queries, clamps limits, retains refs, and maps failures', async () => {
    const app = await buildApp(createHarness());
    const all = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/search' });
    expect(all.json().length).toBeGreaterThan(5);
    const limited = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/search?q=web&limit=0' });
    expect(limited.json()).toHaveLength(1);
    expect(limited.json()[0]).toEqual(expect.objectContaining({ ref: expect.objectContaining({ ctx: 'kind-a', uid: 'web-uid' }) }));
    const max = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/search?limit=9999' });
    expect(max.json().length).toBeLessThanOrEqual(100);
    expect((await app.inject({ method: 'GET', url: '/api/contexts/bad/search?q=x' })).statusCode).toBe(409);
  });
});

describe('schema routes', () => {
  it('builds a self-contained strict schema, caches group documents, and validates query fields', async () => {
    const harness = createHarness();
    const app = await buildApp(harness);
    const response = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/schema?group=apps&version=v1&kind=Deployment' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      $ref: '#/definitions/Deployment',
      definitions: {
        Deployment: expect.objectContaining({ additionalProperties: false }),
        DeploymentSpec: expect.objectContaining({ additionalProperties: false }),
      },
    });
    const preserved = response.json().definitions.DeploymentSpec.properties.template;
    expect(preserved.additionalProperties).toBeUndefined();
    await app.inject({ method: 'GET', url: '/api/contexts/kind-a/schema?group=apps&version=v1&kind=Deployment' });
    expect(harness.rawJson.mock.calls.filter(([requestPath]) => requestPath === '/openapi/apps-v1-hash')).toHaveLength(1);

    const missing = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/schema?version=v1' });
    expect(missing.statusCode).toBe(422);
    const absent = await app.inject({ method: 'GET', url: '/api/contexts/kind-a/schema?version=v1&kind=Pod' });
    expect(absent.statusCode).toBe(404);
  });
});

describe('port-forward routes', () => {
  it('lists, checks ports, runs preflight, starts, stops, and clears forwards', async () => {
    const harness = createHarness();
    const app = await buildApp(harness);
    expect((await app.inject({ method: 'GET', url: '/api/portforwards' })).json()).toEqual([{ id: 'pf-1' }]);
    expect((await app.inject({ method: 'GET', url: '/api/portforwards/port-check?port=8080' })).json()).toEqual({ port: 8080, available: false });
    expect((await app.inject({ method: 'GET', url: '/api/contexts/kind-a/portforwards/preflight?namespace=apps' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/contexts/kind-a/portforwards',
          payload: { namespace: 'apps', targetKind: 'Service', targetName: 'web', remotePort: 80, localPort: 8080 },
        })
      ).json(),
    ).toEqual(expect.objectContaining({ id: 'pf-new', remotePort: 80 }));
    expect((await app.inject({ method: 'DELETE', url: '/api/portforwards/pf-1' })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'DELETE', url: '/api/portforwards' })).json()).toEqual({ ok: true });
    expect(harness.portForwards.stopAll).toHaveBeenCalled();
  });

  it.each(['0', '65536', '1.5', 'nope', ''])('rejects invalid local port %s', async (port) => {
    const app = await buildApp(createHarness());
    const response = await app.inject({ method: 'GET', url: `/api/portforwards/port-check?port=${port}` });
    expect(response.statusCode).toBe(422);
  });

  it('requires preflight namespace and maps stop failures', async () => {
    const app = await buildApp(createHarness());
    expect((await app.inject({ method: 'GET', url: '/api/contexts/kind-a/portforwards/preflight' })).statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url: '/api/portforwards/missing' })).statusCode).toBe(404);
  });
});

describe('settings routes', () => {
  it('reports source precedence and accepts valid absolute or home-relative paths', async () => {
    const harness = createHarness();
    const app = await buildApp(harness);
    expect((await app.inject({ method: 'GET', url: '/api/settings/kubeconfig' })).json()).toEqual(
      expect.objectContaining({ source: 'cli-flag', override: '/cli/config', kubeconfigEnv: null }),
    );

    const file = tempKubeconfig();
    const response = await app.inject({ method: 'PUT', url: '/api/settings/kubeconfig', payload: { path: file } });
    expect(response.statusCode).toBe(200);
    expect(harness.settings.save).toHaveBeenCalledWith({ kubeconfigPath: file });
    expect(harness.clusters.setKubeconfigOverride).toHaveBeenCalledWith(file);

    const homeFile = path.join(os.homedir(), `.kubus-route-${Math.random()}.yaml`);
    const isHomeFile = (candidate: fs.PathOrFileDescriptor) => path.normalize(String(candidate)) === path.normalize(homeFile);
    vi.spyOn(fs, 'existsSync').mockImplementation(isHomeFile);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((candidate: fs.PathOrFileDescriptor) =>
      isHomeFile(candidate) ? kubeconfig() : '{}') as typeof fs.readFileSync);
    const home = await app.inject({
      method: 'PUT',
      url: '/api/settings/kubeconfig',
      payload: { path: `~/${path.basename(homeFile)}` },
    });
    expect(home.statusCode).toBe(200);
  });

  it('clears overrides and validates schema, absolute paths, existence, and kubeconfig syntax', async () => {
    const harness = createHarness();
    const app = await buildApp(harness);
    const cleared = await app.inject({ method: 'PUT', url: '/api/settings/kubeconfig', payload: { path: null } });
    expect(cleared.statusCode).toBe(200);
    expect(harness.ctx.cliKubeconfig).toBeUndefined();
    expect(harness.settings.save).toHaveBeenCalledWith({ kubeconfigPath: undefined });

    expect((await app.inject({ method: 'PUT', url: '/api/settings/kubeconfig', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/kubeconfig', payload: { path: 'relative' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/kubeconfig', payload: { path: '/definitely/missing' } })).statusCode).toBe(400);
    const invalid = tempKubeconfig('not: [valid');
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/kubeconfig', payload: { path: invalid } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('not a valid kubeconfig');
  });

  it('imports kubeconfigs, creates backups, reports auth warnings, and reloads contexts', async () => {
    const target = tempKubeconfig(kubeconfig('base'));
    const incoming = kubeconfig('imported', `missing-plugin-${Math.random()}`)
      .replaceAll('cluster-a', 'cluster-imported')
      .replaceAll('user-a', 'user-imported');
    const harness = createHarness();
    harness.clusters.primaryKubeconfigPath.mockReturnValue(target);
    const app = await buildApp(harness);
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/kubeconfig/import',
      payload: { yaml: incoming },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().added.contexts).toEqual(['imported']);
    expect(response.json().warnings[0]).toContain('was not found on PATH');
    expect(response.json().backupPath).toContain('.kubus.bak');
    expect(harness.clusters.reload).toHaveBeenCalled();
    expect(fs.readFileSync(target, 'utf8')).toContain('name: imported');
  });

  it('rejects imports with invalid bodies, unresolved targets, and conflicts', async () => {
    const harness = createHarness();
    harness.clusters.primaryKubeconfigPath.mockReturnValue(null);
    const app = await buildApp(harness);
    expect((await app.inject({ method: 'POST', url: '/api/settings/kubeconfig/import', payload: {} })).statusCode).toBe(400);
    expect(
      (
        await app.inject({ method: 'POST', url: '/api/settings/kubeconfig/import', payload: { yaml: kubeconfig('new') } })
      ).statusCode,
    ).toBe(400);

    const target = tempKubeconfig(kubeconfig('same'));
    harness.clusters.primaryKubeconfigPath.mockReturnValue(target);
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/settings/kubeconfig/import',
      payload: { yaml: kubeconfig('same').replace('token: token', 'token: different') },
    });
    expect(conflict.statusCode).toBe(409);
  });
});

describe('application and SSH routes', () => {
  it('returns application info and SSH availability without a config file', async () => {
    const harness = createHarness();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const app = await buildApp(harness);
    const info = await app.inject({ method: 'GET', url: '/api/app/info' });
    expect(info.json()).toEqual(expect.objectContaining({ name: 'Kubus', version: expect.any(String), helmEngine: expect.any(Boolean) }));
    const ssh = await app.inject({ method: 'GET', url: '/api/ssh/info' });
    expect(ssh.json()).toEqual(
      expect.objectContaining({ sshAvailable: true, sshVersion: 'OpenSSH_9.9', configExists: false, hosts: [] }),
    );
  });

  it.each([
    [404, undefined, 'no-release'],
    [503, undefined, 'manifest-503'],
    [200, {}, 'missing-version'],
    [200, { version: '0.1.0' }, undefined],
    [200, { version: '99.0.0', releaseUrl: 'http://github.com/FloSch62/Kubus/releases/x' }, 'missing-release-url'],
    [200, { version: '99.0.0', releaseUrl: 'https://example.com/FloSch62/Kubus/releases/x' }, 'missing-release-url'],
    [200, { version: '99.0.0', releaseUrl: 'https://github.com/other/project/releases/x' }, 'missing-release-url'],
  ])('handles update manifest response %#', async (status, body, reason) => {
    const app = await buildApp(createHarness());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })),
    );
    const response = await app.inject({ method: 'GET', url: '/api/app/update-check?force=true' });
    expect(response.statusCode).toBe(200);
    if (reason) expect(response.json().reason).toBe(reason);
    else expect(response.json().available).toBe(false);
  });

  it('accepts a newer trusted GitHub release and drops invalid optional metadata', async () => {
    const app = await buildApp(createHarness());
    const fetchMock = vi.fn(async (_input: unknown): Promise<MockFetchResponse> => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: 'v99.2.3',
        releaseName: 'Kubus 99',
        releaseUrl: 'https://github.com/FloSch62/Kubus/releases/tag/v99.2.3',
        publishedAt: '2026-07-22T00:00:00Z',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await app.inject({ method: 'GET', url: '/api/app/update-check?force=true' });
    expect(response.json()).toEqual({
      available: true,
      currentVersion: expect.any(String),
      latestVersion: '99.2.3',
      releaseName: 'Kubus 99',
      releaseUrl: 'https://github.com/FloSch62/Kubus/releases/tag/v99.2.3',
      publishedAt: '2026-07-22T00:00:00Z',
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('?t=');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        version: '100.0.0',
        releaseName: 42,
        releaseUrl: 'https://github.com/FloSch62/Kubus/releases/tag/v100',
        publishedAt: null,
      }),
    });
    const optional = await app.inject({ method: 'GET', url: '/api/app/update-check?force=true' });
    expect(optional.json().releaseName).toBeUndefined();
    expect(optional.json().publishedAt).toBeUndefined();
  });

  it('classifies update fetch failures as network or timeout and shares non-forced requests', async () => {
    const app = await buildApp(createHarness());
    const fetchMock = vi.fn(async (_input: unknown): Promise<MockFetchResponse> => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);
    expect((await app.inject({ method: 'GET', url: '/api/app/update-check?force=true' })).json().reason).toBe('network');

    const timeout = new Error('aborted');
    timeout.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(timeout);
    expect((await app.inject({ method: 'GET', url: '/api/app/update-check?force=true' })).json().reason).toBe('timeout');

    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await Promise.all([
      app.inject({ method: 'GET', url: '/api/app/update-check?force=true' }),
      app.inject({ method: 'GET', url: '/api/app/update-check' }),
    ]);
    expect(fetchMock).toHaveBeenCalled();
  });
});
