import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  Exec,
  KubeConfig,
  KubernetesObjectApi,
  Log,
  Metrics,
  PortForward,
  VersionApi,
  type ApiConstructor,
  type ApiType,
} from '@kubernetes/client-node';
import type { ContextInfo } from '@kubus/shared';
import { RawClient } from './raw-client.js';
import { DiscoveryCache } from './discovery.js';
import { WatcherRegistry } from './watcher.js';
import { MetricsPoller } from './metrics-poller.js';
import { applyEnvProxy } from './connection.js';
import { patchCluster, writeKubeconfig } from './kubeconfig-file.js';
import { HttpProblem } from '../util/errors.js';
import type { ClusterAuthType } from '@kubus/shared';

function authTypeOf(user: ReturnType<KubeConfig['getUser']>): ClusterAuthType {
  if (!user) return 'none';
  if (user.exec) return 'exec';
  if (user.authProvider) return 'auth-provider';
  if (user.certData || user.certFile) return 'client-cert';
  if (user.token) return 'token';
  if (user.username) return 'basic';
  return 'none';
}

/** Everything the server holds for one connected kubeconfig context. */
export class ClusterHandle {
  readonly kc: KubeConfig;
  readonly raw: RawClient;
  readonly discovery: DiscoveryCache;
  readonly watchers: WatcherRegistry;
  readonly metricsPoller: MetricsPoller;
  health: ContextInfo['health'] = 'connecting';
  healthMessage?: string;
  kubernetesVersion?: string;

  private clients = new Map<string, unknown>();

  constructor(
    baseConfig: KubeConfig,
    public readonly contextName: string,
    log: FastifyBaseLogger,
  ) {
    // Each handle owns its own KubeConfig: setCurrentContext mutates state
    // and exec-auth caches per-instance — never share across contexts.
    this.kc = new KubeConfig();
    this.kc.loadFromString(baseConfig.exportConfig());
    this.kc.setCurrentContext(contextName);
    this.raw = new RawClient(this.kc);
    this.discovery = new DiscoveryCache(this.raw);
    this.watchers = new WatcherRegistry(this.raw, log);
    this.metricsPoller = new MetricsPoller(new Metrics(this.kc), log);
  }

  client<T extends ApiType>(ctor: ApiConstructor<T>): T {
    const key = ctor.name;
    let client = this.clients.get(key);
    if (!client) {
      client = this.kc.makeApiClient(ctor);
      this.clients.set(key, client);
    }
    return client as T;
  }

  get core(): CoreV1Api {
    return this.client(CoreV1Api);
  }
  get apps(): AppsV1Api {
    return this.client(AppsV1Api);
  }
  get batch(): BatchV1Api {
    return this.client(BatchV1Api);
  }
  get objects(): KubernetesObjectApi {
    let api = this.clients.get('KubernetesObjectApi') as KubernetesObjectApi | undefined;
    if (!api) {
      api = KubernetesObjectApi.makeApiClient(this.kc);
      this.clients.set('KubernetesObjectApi', api);
    }
    return api;
  }
  makeExec(): Exec {
    return new Exec(this.kc);
  }
  makeLog(): Log {
    return new Log(this.kc);
  }
  makePortForward(): PortForward {
    return new PortForward(this.kc);
  }

  async probe(): Promise<void> {
    try {
      const info = await this.client(VersionApi).getCode();
      this.kubernetesVersion = info.gitVersion;
      this.health = 'connected';
      this.healthMessage = undefined;
    } catch (err) {
      this.health = 'error';
      this.healthMessage = err instanceof Error ? err.message : String(err);
    }
  }

  /** Start background machinery used by the overview dashboard + metrics. */
  activate(): void {
    this.metricsPoller.start();
    // Pin overview watchers (never released; cheap and shared with the UI).
    this.watchers.acquire('', 'v1', 'pods');
    this.watchers.acquire('apps', 'v1', 'deployments');
    this.watchers.acquire('', 'v1', 'events');
    this.watchers.acquire('', 'v1', 'nodes');
    this.watchers.acquire('', 'v1', 'namespaces');
  }

  dispose(): void {
    this.metricsPoller.stop();
    this.watchers.stopAll();
  }
}

export class ClusterManager extends EventEmitter {
  private kc = new KubeConfig();
  private handles = new Map<string, ClusterHandle>();
  private fsWatchers: fs.FSWatcher[] = [];
  /** Cluster names whose proxy-url was injected from env vars (not the kubeconfig). */
  private envProxyClusters = new Set<string>();

  constructor(
    private log: FastifyBaseLogger,
    private kubeconfigOverride?: string,
  ) {
    super();
    this.loadKubeconfig();
    this.watchKubeconfigFiles();
  }

  private loadKubeconfig(): void {
    try {
      if (this.kubeconfigOverride) {
        this.kc.loadFromFile(this.kubeconfigOverride);
      } else {
        this.kc.loadFromDefault();
      }
    } catch (err) {
      this.log.warn({ err: String(err) }, 'failed to load kubeconfig');
    }
    // Bridge standard proxy env vars (client-node only reads kubeconfig proxy-url).
    this.envProxyClusters = applyEnvProxy(this.kc);
  }

  private kubeconfigPaths(): string[] {
    if (this.kubeconfigOverride) return [this.kubeconfigOverride];
    const env = process.env.KUBECONFIG;
    if (env) return env.split(path.delimiter).filter(Boolean);
    const home = os.homedir();
    return home ? [path.join(home, '.kube', 'config')] : [];
  }

  getKubeconfigPaths(): string[] {
    return this.kubeconfigPaths();
  }

  /** The file kubeconfig imports are written to. */
  primaryKubeconfigPath(): string | null {
    return this.kubeconfigPaths()[0] ?? null;
  }

  getKubeconfigOverride(): string | undefined {
    return this.kubeconfigOverride;
  }

  /** Re-point the kubeconfig at runtime: reload contexts and re-watch files. */
  setKubeconfigOverride(p: string | undefined): void {
    this.kubeconfigOverride = p;
    for (const w of this.fsWatchers) w.close();
    this.fsWatchers = [];
    this.reload();
    this.watchKubeconfigFiles();
  }

  private watchKubeconfigFiles(): void {
    for (const p of this.kubeconfigPaths()) {
      try {
        let debounce: NodeJS.Timeout | undefined;
        const w = fs.watch(p, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => this.reload(), 500);
        });
        w.unref();
        this.fsWatchers.push(w);
      } catch {
        // file may not exist yet
      }
    }
  }

  reload(): void {
    this.log.info('kubeconfig changed, reloading');
    this.kc = new KubeConfig();
    this.loadKubeconfig();
    const valid = new Set(this.kc.getContexts().map((c) => c.name));
    for (const [name, handle] of this.handles) {
      if (!valid.has(name)) {
        handle.dispose();
        this.handles.delete(name);
      }
    }
    this.emit('contexts-changed');
  }

  listContexts(): ContextInfo[] {
    const current = this.kc.getCurrentContext();
    return this.kc.getContexts().map((c) => {
      const handle = this.handles.get(c.name);
      const cluster = this.kc.getCluster(c.cluster);
      const user = this.kc.getUser(c.user);
      return {
        name: c.name,
        cluster: c.cluster,
        user: c.user,
        namespace: c.namespace ?? undefined,
        server: cluster?.server,
        current: c.name === current,
        health: handle?.health ?? 'unknown',
        healthMessage: handle?.healthMessage,
        active: !!handle,
        kubernetesVersion: handle?.kubernetesVersion,
        proxyUrl: cluster?.proxyUrl,
        proxyFromEnv: this.envProxyClusters.has(c.cluster) || undefined,
        tlsServerName: cluster?.tlsServerName,
        skipTlsVerify: cluster?.skipTLSVerify || undefined,
        caPresent: !!(cluster?.caData || cluster?.caFile) || undefined,
        authType: authTypeOf(user),
      };
    });
  }

  /** Decoded CA certificate PEM for a context's cluster, or null if none. */
  getClusterCa(contextName: string): string | null {
    const ctxObj = this.kc.getContexts().find((c) => c.name === contextName);
    if (!ctxObj) throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
    const cluster = this.kc.getCluster(ctxObj.cluster);
    if (!cluster) return null;
    if (cluster.caData) return Buffer.from(cluster.caData, 'base64').toString('utf8');
    if (cluster.caFile) {
      try {
        return fs.readFileSync(cluster.caFile, 'utf8');
      } catch {
        return null;
      }
    }
    return null;
  }

  /** One-shot connectivity probe without persisting a handle (for "Test connection"). */
  async test(contextName: string): Promise<{ health: 'connected' | 'error'; healthMessage?: string; kubernetesVersion?: string }> {
    if (!this.kc.getContexts().some((c) => c.name === contextName)) {
      throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
    }
    const kc = new KubeConfig();
    kc.loadFromString(this.kc.exportConfig());
    kc.setCurrentContext(contextName);
    try {
      const info = await kc.makeApiClient(VersionApi).getCode();
      return { health: 'connected', kubernetesVersion: info.gitVersion };
    } catch (err) {
      return { health: 'error', healthMessage: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Full edit of a context's cluster + user, persisted into the kubeconfig file
   * that defines it (atomic write + backup), then reload so the change takes
   * effect on the next connect.
   */
  editCluster(contextName: string, patch: Parameters<typeof patchCluster>[2]): void {
    const ctxObj = this.kc.getContexts().find((c) => c.name === contextName);
    if (!ctxObj) throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
    const file = this.findClusterFile(ctxObj.cluster);
    if (!file) throw new HttpProblem(400, `could not find a kubeconfig file defining cluster "${ctxObj.cluster}"`, 'BadRequest');
    const patched = patchCluster(fs.readFileSync(file, 'utf8'), contextName, patch);
    writeKubeconfig(file, patched);
    // Drop any active handle so it reconnects with the new settings.
    this.disconnect(contextName);
    this.reload();
  }

  /** Locate the kubeconfig file (among the watched paths) that defines a cluster. */
  private findClusterFile(clusterName: string): string | null {
    for (const p of this.kubeconfigPaths()) {
      try {
        const kc = new KubeConfig();
        kc.loadFromFile(p);
        if (kc.getClusters().some((c) => c.name === clusterName)) return p;
      } catch {
        // unreadable / invalid file — skip
      }
    }
    return null;
  }

  /** Get an active handle or throw 400/404. */
  get(contextName: string): ClusterHandle {
    const handle = this.handles.get(contextName);
    if (!handle) throw new HttpProblem(409, `context "${contextName}" is not connected`, 'NotConnected');
    return handle;
  }

  has(contextName: string): boolean {
    return this.handles.has(contextName);
  }

  async connect(contextName: string): Promise<ClusterHandle> {
    const existing = this.handles.get(contextName);
    if (existing) return existing;
    if (!this.kc.getContexts().some((c) => c.name === contextName)) {
      throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
    }
    const handle = new ClusterHandle(this.kc, contextName, this.log);
    this.handles.set(contextName, handle);
    await handle.probe();
    if (handle.health === 'connected') {
      handle.activate();
    }
    return handle;
  }

  disconnect(contextName: string): void {
    const handle = this.handles.get(contextName);
    if (handle) {
      handle.dispose();
      this.handles.delete(contextName);
    }
  }

  dispose(): void {
    for (const w of this.fsWatchers) w.close();
    for (const handle of this.handles.values()) handle.dispose();
    this.handles.clear();
  }
}
