/* oxlint-disable typescript/unbound-method -- prototype and collaborator methods are deliberately captured as mocks. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
} from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClusterHandle, ClusterManager } from '../../../server/src/kube/cluster-manager';
import { CrdTracker } from '../../../server/src/kube/crd-tracker';
import { MetricsPoller } from '../../../server/src/kube/metrics-poller';
import { NetworkMetricsPoller } from '../../../server/src/kube/network-poller';
import { RawClient } from '../../../server/src/kube/raw-client';
import { ResourceSearchIndex } from '../../../server/src/kube/search-index';
import type { SshTunnelManager } from '../../../server/src/ssh/tunnel-manager';
import { WatcherRegistry } from '../../../server/src/kube/watcher';

interface ManagerInternals {
  kc: KubeConfig;
  contextFiles: Map<string, string>;
  handles: Map<string, ClusterHandle>;
  connecting: Map<string, Promise<ClusterHandle>>;
  fsWatchers: Array<{ close(): void }>;
  watchRetryTimers: NodeJS.Timeout[];
  reloadDebounce?: NodeJS.Timeout;
  healthCache: Map<string, { health: 'unknown' | 'connecting' | 'connected' | 'error'; healthMessage?: string; kubernetesVersion?: string }>;
  healthTimer?: NodeJS.Timeout;
  healthRun?: Promise<void>;
  probeClients: Map<string, { raw: RawClient; proxyUrl?: string }>;
  envProxyClusters: Set<string>;
  kubeconfigOverride?: string;
  loadKubeconfig(): void;
  kubeconfigPaths(): string[];
  closeFileWatchers(): void;
  watchKubeconfigFiles(): void;
  watchKubeconfigDir(dir: string, names: Set<string>): void;
  scheduleReload(): void;
  contextFingerprints(): Map<string, string>;
  sshProxyFor(contextName: string): Promise<string | undefined>;
  probeClient(contextName: string): Promise<RawClient>;
  probeContext(contextName: string, timeoutMs: number): Promise<{ health: 'connected' | 'error'; healthMessage?: string; kubernetesVersion?: string }>;
  setCachedHealth(contextName: string, next: { health: 'unknown' | 'connecting' | 'connected' | 'error'; healthMessage?: string; kubernetesVersion?: string }): boolean;
  refreshCachedHealth(): void;
  refreshCachedHealthNow(): Promise<void>;
  sshTunnelKeyForContext(contextName: string): string | null;
  contextFilesByName(): Map<string, string>;
  scanContextFiles(): Map<string, string>;
  findEntryFile(kind: 'context' | 'cluster' | 'user', name: string | undefined): string | null;
  disconnectHandlesForEntries(clusterName: string, userName: string | undefined): void;
  connectFresh(contextName: string): Promise<ClusterHandle>;
}

interface TrackerInternals {
  onChange(): void;
}

interface FakeFsWatcher {
  close: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

const managers: ClusterManager[] = [];
const tempDirs: string[] = [];

function logger(): FastifyBaseLogger {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
}

function kubeconfigYaml(options: {
  contexts?: Array<{ name: string; cluster?: string; user?: string; namespace?: string }>;
  current?: string;
  caData?: string;
  caFile?: string;
  token?: string;
} = {}): string {
  const contexts = options.contexts ?? [
    { name: 'kind-a', cluster: 'cluster-a', user: 'user-a', namespace: 'default' },
    { name: 'kind-b', cluster: 'cluster-a', user: 'user-a' },
  ];
  const caLines = options.caData
    ? [`      certificate-authority-data: ${options.caData}`]
    : options.caFile
      ? [`      certificate-authority: ${options.caFile}`]
      : [];
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '  - name: cluster-a',
    '    cluster:',
    '      server: https://127.0.0.1:6443',
    ...caLines,
    'users:',
    '  - name: user-a',
    '    user:',
    `      token: ${options.token ?? 'test-token'}`,
    'contexts:',
    ...contexts.flatMap((context) => [
      `  - name: ${context.name}`,
      '    context:',
      ...(context.cluster ? [`      cluster: ${context.cluster}`] : []),
      ...(context.user ? [`      user: ${context.user}`] : []),
      ...(context.namespace ? [`      namespace: ${context.namespace}`] : []),
    ]),
    `current-context: ${options.current ?? contexts[0]?.name ?? ''}`,
    '',
  ].join('\n');
}

function writeFixture(yaml = kubeconfigYaml()): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubus-cluster-manager-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, yaml);
  return { dir, file };
}

function baseConfig(yaml = kubeconfigYaml()): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromString(yaml);
  return kc;
}

function mockFsWatch() {
  const callbacks: Array<(event: string, filename: string | Buffer | null) => void> = [];
  const watchers: FakeFsWatcher[] = [];
  vi.spyOn(fs, 'watch').mockImplementation(((
    _dir: fs.PathLike,
    callback: (event: string, filename: string | Buffer | null) => void,
  ) => {
    callbacks.push(callback);
    const watcher = { close: vi.fn(), unref: vi.fn() };
    watchers.push(watcher);
    return watcher;
  }) as unknown as typeof fs.watch);
  return { callbacks, watchers };
}

function sshHarness() {
  const hosts = new Map<string, string>();
  const tunnel = {
    hostForContextKey: vi.fn((key: string) => hosts.get(key)),
    rekeyContext: vi.fn((oldKey: string, newKey: string) => {
      const host = hosts.get(oldKey);
      if (!host) return;
      if (!hosts.has(newKey)) hosts.set(newKey, host);
      hosts.delete(oldKey);
    }),
    setHostForContextKey: vi.fn((key: string, value: string | null) => {
      if (value === null) hosts.delete(key);
      else hosts.set(key, value);
    }),
    ensure: vi.fn(async (host: string) => `socks5h://127.0.0.1:${host === 'jump' ? 4100 : 4200}`),
  } as unknown as SshTunnelManager;
  return { tunnel, hosts };
}

function createManager(file: string, ssh?: SshTunnelManager): ClusterManager {
  const manager = new ClusterManager(logger(), file, ssh);
  managers.push(manager);
  return manager;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFsWatch();
  vi.spyOn(RawClient.prototype, 'json').mockResolvedValue({ gitVersion: 'v1.33.0' });
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ClusterHandle', () => {
  it('clones config, caches API clients, probes, activates once, relays discovery, and disposes', async () => {
    const makeClient = vi.spyOn(KubeConfig.prototype, 'makeApiClient').mockImplementation((ctor) => ({ ctor }) as never);
    const objectClient = { objectApi: true };
    vi.spyOn(KubernetesObjectApi, 'makeApiClient').mockReturnValue(objectClient as unknown as KubernetesObjectApi);
    const metricsStart = vi.spyOn(MetricsPoller.prototype, 'start').mockImplementation(() => {});
    const metricsStop = vi.spyOn(MetricsPoller.prototype, 'stop').mockImplementation(() => {});
    const networkStart = vi.spyOn(NetworkMetricsPoller.prototype, 'start').mockImplementation(() => {});
    const networkStop = vi.spyOn(NetworkMetricsPoller.prototype, 'stop').mockImplementation(() => {});
    const crdStart = vi.spyOn(CrdTracker.prototype, 'start').mockImplementation(() => {});
    const crdStop = vi.spyOn(CrdTracker.prototype, 'stop').mockImplementation(() => {});
    const acquire = vi.spyOn(WatcherRegistry.prototype, 'acquire').mockReturnValue({} as never);
    const stopAll = vi.spyOn(WatcherRegistry.prototype, 'stopAll').mockImplementation(() => {});
    const warm = vi.spyOn(ResourceSearchIndex.prototype, 'warm').mockImplementation(() => {});
    const disposeIndex = vi.spyOn(ResourceSearchIndex.prototype, 'dispose').mockImplementation(() => {});
    const rawJson = vi.spyOn(RawClient.prototype, 'json').mockResolvedValue({ gitVersion: 'v1.31.7' });

    const handle = new ClusterHandle(baseConfig(), 'kind-a', logger(), 'socks5h://127.0.0.1:4100');
    expect(handle.kc).not.toBe(baseConfig());
    expect(handle.kc.getCurrentContext()).toBe('kind-a');
    expect(handle.kc.getCurrentCluster()?.proxyUrl).toBe('socks5h://127.0.0.1:4100');

    expect(handle.core).toBe(handle.core);
    expect(handle.apps).toBe(handle.apps);
    expect(handle.batch).toBe(handle.batch);
    expect(makeClient).toHaveBeenCalledWith(CoreV1Api);
    expect(makeClient).toHaveBeenCalledWith(AppsV1Api);
    expect(makeClient).toHaveBeenCalledWith(BatchV1Api);
    expect(handle.objects).toBe(objectClient);
    expect(handle.objects).toBe(objectClient);
    expect(handle.makeExec()).toBeDefined();
    expect(handle.makeLog()).toBeDefined();
    expect(handle.makePortForward()).toBeDefined();

    await handle.probe();
    expect(handle.health).toBe('connected');
    expect(handle.kubernetesVersion).toBe('v1.31.7');
    expect(handle.healthMessage).toBeUndefined();

    rawJson.mockRejectedValueOnce({ code: 401 });
    await handle.probe();
    expect(handle.health).toBe('error');
    expect(handle.healthMessage).toContain('401 Unauthorized');

    const discoveryChanged = vi.fn();
    handle.onDiscoveryChanged = discoveryChanged;
    (handle.crdTracker as unknown as TrackerInternals).onChange();
    expect(discoveryChanged).toHaveBeenCalled();

    handle.activate();
    handle.activate();
    expect(metricsStart).toHaveBeenCalledTimes(1);
    expect(networkStart).toHaveBeenCalledTimes(1);
    expect(crdStart).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['', 'v1', 'pods'],
      ['apps', 'v1', 'deployments'],
      ['', 'v1', 'events'],
      ['', 'v1', 'nodes'],
      ['', 'v1', 'namespaces'],
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(warm).toHaveBeenCalledTimes(1);

    handle.dispose();
    expect(metricsStop).toHaveBeenCalled();
    expect(networkStop).toHaveBeenCalled();
    expect(crdStop).toHaveBeenCalled();
    expect(stopAll).toHaveBeenCalled();
    expect(disposeIndex).toHaveBeenCalled();
  });
});

describe('ClusterManager context metadata and health', () => {
  it('loads, watches, lists context details, exposes paths, and closes watchers', async () => {
    const ca = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n';
    const { file } = writeFixture(kubeconfigYaml({ caData: Buffer.from(ca).toString('base64') }));
    const { tunnel, hosts } = sshHarness();
    const manager = createManager(file, tunnel);
    const internals = manager as unknown as ManagerInternals;
    const key = internals.sshTunnelKeyForContext('kind-a')!;
    hosts.set(key, 'jump');
    await vi.waitFor(() => expect(manager.listContexts().every((context) => context.health === 'connected')).toBe(true));

    expect(manager.getKubeconfigPaths()).toEqual([file]);
    expect(manager.primaryKubeconfigPath()).toBe(file);
    expect(manager.getKubeconfigOverride()).toBe(file);
    expect(manager.getClusterCa('kind-a')).toBe(ca);
    expect(manager.getClusterCa('kind-b')).toBe(ca);
    expect(manager.listContexts()).toEqual([
      expect.objectContaining({
        name: 'kind-a',
        namespace: 'default',
        current: true,
        active: false,
        server: 'https://127.0.0.1:6443',
        health: 'connected',
        kubernetesVersion: 'v1.33.0',
        sshHost: 'jump',
        caPresent: true,
        authType: 'token',
      }),
      expect.objectContaining({ name: 'kind-b', current: false, health: 'connected' }),
    ]);

    expect(() => manager.getClusterCa('missing')).toThrow('not found in kubeconfig');
    internals.closeFileWatchers();
    expect(internals.fsWatchers).toEqual([]);
    expect(internals.watchRetryTimers).toEqual([]);
  });

  it('reads CA files and returns null for missing cluster data or unreadable files', () => {
    const caFixture = writeFixture('placeholder');
    const caFile = path.join(caFixture.dir, 'ca.pem');
    fs.writeFileSync(caFile, 'PEM DATA');
    fs.writeFileSync(caFixture.file, kubeconfigYaml({ caFile }));
    const manager = createManager(caFixture.file);
    expect(manager.getClusterCa('kind-a')).toBe('PEM DATA');

    fs.rmSync(caFile);
    expect(manager.getClusterCa('kind-a')).toBeNull();
    const internals = manager as unknown as ManagerInternals;
    internals.kc.clusters = [];
    expect(manager.getClusterCa('kind-a')).toBeNull();
  });

  it('probes on demand, emits only for changed health, and handles timeouts and client failures', async () => {
    const { file } = writeFixture();
    const manager = createManager(file);
    const internals = manager as unknown as ManagerInternals;
    const changed = vi.fn();
    manager.on('contexts-changed', changed);

    await expect(manager.test('missing')).rejects.toMatchObject({ statusCode: 404 });
    expect(await manager.test('kind-a')).toEqual({ health: 'connected', kubernetesVersion: 'v1.33.0' });
    const afterFirst = changed.mock.calls.length;
    await manager.test('kind-a');
    expect(changed.mock.calls.length).toBe(afterFirst);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    vi.spyOn(RawClient.prototype, 'json').mockRejectedValueOnce(abort);
    internals.probeClients.clear();
    expect(await internals.probeContext('kind-a', 2000)).toEqual({ health: 'error', healthMessage: 'timed out after 2s' });

    internals.probeClient = vi.fn(async () => Promise.reject(new Error('credential helper failed')));
    expect(await internals.probeContext('kind-a', 1000)).toEqual(
      expect.objectContaining({ health: 'error', healthMessage: expect.stringContaining('credential helper failed') }),
    );
  });

  it('updates activated handles from cache and coalesces background health runs', async () => {
    const { file } = writeFixture();
    const manager = createManager(file);
    const internals = manager as unknown as ManagerInternals;
    const handle = {
      activated: true,
      health: 'connecting',
      healthMessage: undefined,
      kubernetesVersion: undefined,
      dispose: vi.fn(),
    } as unknown as ClusterHandle;
    internals.handles.set('kind-a', handle);

    expect(internals.setCachedHealth('kind-a', { health: 'connected', kubernetesVersion: 'v1.30.0' })).toBe(true);
    expect(handle.health).toBe('connected');
    expect(internals.setCachedHealth('kind-a', { health: 'connected', kubernetesVersion: 'v1.30.0' })).toBe(false);

    internals.kc.contexts = internals.kc.contexts.filter((context) => context.name === 'kind-a');
    let release!: () => void;
    internals.probeContext = vi.fn(
      async () =>
        new Promise<{ health: 'connected'; kubernetesVersion: string }>((resolve) => {
          release = () => resolve({ health: 'connected', kubernetesVersion: 'v1.31.0' });
        }),
    );
    internals.healthRun = undefined;
    internals.refreshCachedHealth();
    const run = internals.healthRun;
    internals.refreshCachedHealth();
    expect(internals.healthRun).toBe(run);
    release();
    await Promise.resolve(run);
    expect(internals.healthRun).toBeUndefined();
  });
});

describe('ClusterManager file watching and reloads', () => {
  it('filters directory events, debounces relevant changes, and retries missing directories', async () => {
    const { file } = writeFixture();
    const watch = mockFsWatch();
    const manager = createManager(file);
    const internals = manager as unknown as ManagerInternals;
    const reload = vi.spyOn(manager, 'reload').mockImplementation(() => {});
    const callback = watch.callbacks.at(-1)!;

    callback('change', 'other-file');
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).not.toHaveBeenCalled();
    callback('rename', path.basename(file));
    callback('change', null);
    await vi.advanceTimersByTimeAsync(299);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);

    vi.spyOn(fs, 'watch').mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    internals.watchKubeconfigDir('/missing', new Set(['config']));
    expect(internals.watchRetryTimers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(internals.watchRetryTimers).toHaveLength(0);
  });

  it('drops changed and removed sessions and cached health during reload', async () => {
    const { file } = writeFixture();
    const manager = createManager(file);
    const internals = manager as unknown as ManagerInternals;
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    internals.handles.set('kind-a', { dispose: disposeA } as unknown as ClusterHandle);
    internals.handles.set('kind-b', { dispose: disposeB } as unknown as ClusterHandle);
    internals.healthCache.set('kind-a', { health: 'connected' });
    internals.healthCache.set('kind-b', { health: 'connected' });
    const reset = vi.fn();
    const contextsChanged = vi.fn();
    manager.on('context-reset', reset);
    manager.on('contexts-changed', contextsChanged);

    fs.writeFileSync(file, kubeconfigYaml({ contexts: [{ name: 'kind-a', cluster: 'cluster-a', user: 'user-a', namespace: 'changed' }] }));
    manager.reload();
    expect(disposeA).toHaveBeenCalled();
    expect(disposeB).toHaveBeenCalled();
    expect(internals.handles.size).toBe(0);
    expect(internals.healthCache.has('kind-b')).toBe(false);
    expect(reset).toHaveBeenCalledWith('kind-a');
    expect(reset).toHaveBeenCalledWith('kind-b');
    expect(contextsChanged).toHaveBeenCalled();
  });

  it('switches overrides and derives env/default paths', () => {
    const first = writeFixture();
    const second = writeFixture(kubeconfigYaml({ contexts: [{ name: 'other', cluster: 'cluster-a', user: 'user-a' }], current: 'other' }));
    const manager = createManager(first.file);
    const internals = manager as unknown as ManagerInternals;
    manager.setKubeconfigOverride(second.file);
    expect(manager.getKubeconfigOverride()).toBe(second.file);
    expect(manager.listContexts().map((context) => context.name)).toEqual(['other']);

    internals.kubeconfigOverride = undefined;
    vi.stubEnv('KUBECONFIG', `${first.file}${path.delimiter}${second.file}`);
    expect(internals.kubeconfigPaths()).toEqual([first.file, second.file]);
    vi.stubEnv('KUBECONFIG', '');
    expect(internals.kubeconfigPaths()[0]).toContain(path.join('.kube', 'config'));
  });

  it('keeps an SSH jump host when a multi-file reload moves a context to another file', () => {
    const first = writeFixture(kubeconfigYaml({ contexts: [{ name: 'other', cluster: 'cluster-a', user: 'user-a' }], current: 'other' }));
    const second = writeFixture(
      kubeconfigYaml({ contexts: [{ name: 'kind-a', cluster: 'cluster-a', user: 'user-a' }], current: 'kind-a' })
        .replaceAll('cluster-a', 'cluster-kind-a')
        .replaceAll('user-a', 'user-kind-a'),
    );
    vi.stubEnv('KUBECONFIG', `${first.file}${path.delimiter}${second.file}`);
    const { tunnel, hosts } = sshHarness();
    const manager = new ClusterManager(logger(), undefined, tunnel);
    managers.push(manager);
    const internals = manager as unknown as ManagerInternals;
    const oldKey = internals.sshTunnelKeyForContext('kind-a')!;
    manager.setSshHost('kind-a', 'jump');

    fs.writeFileSync(
      first.file,
      kubeconfigYaml({
        contexts: [
          { name: 'other', cluster: 'cluster-a', user: 'user-a' },
          { name: 'kind-a', cluster: 'cluster-a', user: 'user-a' },
        ],
        current: 'other',
      }),
    );
    manager.reload();

    const newKey = internals.sshTunnelKeyForContext('kind-a')!;
    expect(newKey).not.toBe(oldKey);
    expect(hosts.has(oldKey)).toBe(false);
    expect(hosts.get(newKey)).toBe('jump');
    expect(manager.listContexts().find((context) => context.name === 'kind-a')?.sshHost).toBe('jump');
    expect(tunnel.rekeyContext).toHaveBeenCalledWith(oldKey, newKey);
  });
});

describe('ClusterManager connections and SSH', () => {
  it('reuses active/in-flight connects, activates healthy handles, relays discovery, disconnects, and reconnects', async () => {
    const { file } = writeFixture();
    const manager = createManager(file);
    const internals = manager as unknown as ManagerInternals;
    const originalProbe = ClusterHandle.prototype.probe;
    let release!: () => void;
    vi.spyOn(ClusterHandle.prototype, 'probe').mockImplementation(async function probe(this: ClusterHandle) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      this.health = 'connected';
    });
    const activate = vi.spyOn(ClusterHandle.prototype, 'activate').mockImplementation(function activate(this: ClusterHandle) {
      this.activated = true;
    });
    const dispose = vi.spyOn(ClusterHandle.prototype, 'dispose').mockImplementation(() => {});
    const reset = vi.fn();
    const changed = vi.fn();
    const discovery = vi.fn();
    manager.on('context-reset', reset);
    manager.on('contexts-changed', changed);
    manager.on('discovery-changed', discovery);

    const first = manager.connect('kind-a');
    const second = manager.connect('kind-a');
    await vi.waitFor(() => expect(internals.connecting.has('kind-a')).toBe(true));
    release();
    const [handleA, handleB] = await Promise.all([first, second]);
    expect(handleA).toBe(handleB);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(await manager.connect('kind-a')).toBe(handleA);
    handleA.onDiscoveryChanged?.();
    expect(discovery).toHaveBeenCalledWith('kind-a');
    expect(manager.has('kind-a')).toBe(true);
    expect(manager.get('kind-a')).toBe(handleA);

    manager.disconnect('kind-a');
    expect(dispose).toHaveBeenCalled();
    expect(manager.has('kind-a')).toBe(false);
    expect(() => manager.get('kind-a')).toThrow('not connected');
    manager.disconnect('kind-a');

    vi.spyOn(ClusterHandle.prototype, 'probe').mockRestore();
    vi.spyOn(ClusterHandle.prototype, 'probe').mockImplementation(async function connected(this: ClusterHandle) {
      this.health = 'connected';
    });
    vi.spyOn(ClusterHandle.prototype, 'activate').mockImplementation(() => {});
    const reconnected = await manager.reconnect('kind-a');
    expect(reconnected).not.toBe(handleA);
    expect(reset).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    void originalProbe;
  });

  it('rejects missing contexts, SSH startup failures, removed contexts, and handles dropped mid-probe', async () => {
    const { file } = writeFixture();
    const { tunnel, hosts } = sshHarness();
    const manager = createManager(file, tunnel);
    const internals = manager as unknown as ManagerInternals;
    await expect(manager.connect('missing')).rejects.toMatchObject({ statusCode: 404 });

    const key = internals.sshTunnelKeyForContext('kind-a')!;
    hosts.set(key, 'jump');
    (tunnel.ensure as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce('tunnel boom');
    await expect(manager.connect('kind-a')).rejects.toMatchObject({ statusCode: 502, message: 'tunnel boom' });

    let releaseRemoved!: () => void;
    vi.spyOn(ClusterHandle.prototype, 'probe').mockImplementation(async function delayed(this: ClusterHandle) {
      await new Promise<void>((resolve) => {
        releaseRemoved = resolve;
      });
      this.health = 'connected';
    });
    const removed = manager.connect('kind-a');
    await vi.waitFor(() => expect(internals.handles.has('kind-a')).toBe(true));
    internals.kc.contexts = internals.kc.contexts.filter((context) => context.name !== 'kind-a');
    releaseRemoved();
    await expect(removed).rejects.toMatchObject({ statusCode: 404 });

    manager.reload();
    let releaseDropped!: () => void;
    const dropped = manager.connect('kind-a');
    await vi.waitFor(() => expect(internals.handles.has('kind-a')).toBe(true));
    internals.handles.delete('kind-a');
    releaseDropped = releaseRemoved;
    releaseDropped();
    await expect(dropped).rejects.toMatchObject({ statusCode: 409 });
  });

  it('manages SSH host settings, validates inputs, and rebuilds proxy clients when tunnel URLs move', async () => {
    const { file } = writeFixture();
    const { tunnel, hosts } = sshHarness();
    const manager = createManager(file, tunnel);
    const internals = manager as unknown as ManagerInternals;
    const key = internals.sshTunnelKeyForContext('kind-a')!;

    manager.setSshHost('kind-a', 'jump');
    expect(hosts.get(key)).toBe('jump');
    manager.setSshHost('kind-a', 'jump');
    expect(tunnel.setHostForContextKey).toHaveBeenCalledTimes(1);
    expect(await internals.sshProxyFor('kind-a')).toBe('socks5h://127.0.0.1:4100');
    const first = await internals.probeClient('kind-a');
    const second = await internals.probeClient('kind-a');
    expect(second).toBe(first);
    (tunnel.ensure as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('socks5h://127.0.0.1:9999');
    const moved = await internals.probeClient('kind-a');
    expect(moved).not.toBe(first);

    manager.setSshHost('kind-a', null);
    expect(hosts.has(key)).toBe(false);
    expect(() => manager.setSshHost('kind-a', '-bad')).toThrow('SSH jump host');
    expect(() => manager.setSshHost('missing', 'jump')).toThrow('not found');

    const withoutSsh = createManager(file);
    expect(() => withoutSsh.setSshHost('kind-a', 'jump')).toThrow('SSH tunnel support is not available');
    expect(await (withoutSsh as unknown as ManagerInternals).sshProxyFor('kind-a')).toBeUndefined();
  });
});
