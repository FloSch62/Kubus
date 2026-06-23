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
import type { ContextInfo, TestConnectionResponse } from '@kubus/shared';
import { RawClient } from './raw-client.js';
import { DiscoveryCache } from './discovery.js';
import { WatcherRegistry } from './watcher.js';
import { MetricsPoller } from './metrics-poller.js';
import { ResourceSearchIndex } from './search-index.js';
import { applyEnvProxy, applyProxyRuntimeCompatibility } from './connection.js';
import { patchClusterEntry, patchUserEntry, writeKubeconfig, type ClusterEditPatch } from './kubeconfig-file.js';
import { HttpProblem } from '../util/errors.js';
import type { ClusterAuthType } from '@kubus/shared';

const BACKGROUND_HEALTH_INTERVAL_MS = 60_000;
const BACKGROUND_HEALTH_TIMEOUT_MS = 8_000;
const BACKGROUND_HEALTH_CONCURRENCY = 4;

type CachedContextHealth = Pick<ContextInfo, 'health' | 'healthMessage' | 'kubernetesVersion'>;

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
  readonly searchIndex: ResourceSearchIndex;
  health: ContextInfo['health'] = 'connecting';
  healthMessage?: string;
  kubernetesVersion?: string;
  activated = false;

  private clients = new Map<string, unknown>();
  private searchIndexWarmup?: NodeJS.Timeout;

  constructor(
    baseConfig: KubeConfig,
    public readonly contextName: string,
    log: FastifyBaseLogger,
  ) {
    // Each handle owns its own KubeConfig: setCurrentContext mutates state
    // and exec-auth caches per-instance — never share across contexts.
    this.kc = new KubeConfig();
    this.kc.loadFromString(baseConfig.exportConfig());
    applyProxyRuntimeCompatibility(this.kc);
    this.kc.setCurrentContext(contextName);
    this.raw = new RawClient(this.kc);
    this.discovery = new DiscoveryCache(this.raw);
    this.watchers = new WatcherRegistry(this.raw, log);
    this.metricsPoller = new MetricsPoller(new Metrics(this.kc), log);
    this.searchIndex = new ResourceSearchIndex(this.discovery, this.raw, log);
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
    if (this.activated) return;
    this.activated = true;
    this.metricsPoller.start();
    // Pin overview watchers (never released; cheap and shared with the UI).
    this.watchers.acquire('', 'v1', 'pods');
    this.watchers.acquire('apps', 'v1', 'deployments');
    this.watchers.acquire('', 'v1', 'events');
    this.watchers.acquire('', 'v1', 'nodes');
    this.watchers.acquire('', 'v1', 'namespaces');
    this.searchIndexWarmup = setTimeout(() => this.searchIndex.warm(), 1_000);
    this.searchIndexWarmup.unref();
  }

  dispose(): void {
    if (this.searchIndexWarmup) clearTimeout(this.searchIndexWarmup);
    this.metricsPoller.stop();
    this.watchers.stopAll();
    this.searchIndex.dispose();
  }
}

export class ClusterManager extends EventEmitter {
  private kc = new KubeConfig();
  private handles = new Map<string, ClusterHandle>();
  private fsWatchers: fs.FSWatcher[] = [];
  private healthCache = new Map<string, CachedContextHealth>();
  private healthTimer?: NodeJS.Timeout;
  private healthRun?: Promise<void>;
  /** Cluster names whose proxy-url was injected from env vars (not the kubeconfig). */
  private envProxyClusters = new Set<string>();

  constructor(
    private log: FastifyBaseLogger,
    private kubeconfigOverride?: string,
  ) {
    super();
    this.loadKubeconfig();
    this.watchKubeconfigFiles();
    this.healthTimer = setInterval(() => this.refreshCachedHealth(), BACKGROUND_HEALTH_INTERVAL_MS);
    this.healthTimer.unref();
    this.refreshCachedHealth();
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
    for (const name of this.healthCache.keys()) {
      if (!valid.has(name)) this.healthCache.delete(name);
    }
    this.refreshCachedHealth();
    this.emit('contexts-changed');
  }

  listContexts(): ContextInfo[] {
    const current = this.kc.getCurrentContext();
    return this.kc.getContexts().map((c) => {
      const handle = this.handles.get(c.name);
      const cachedHealth = this.healthCache.get(c.name);
      const cluster = this.kc.getCluster(c.cluster);
      const user = this.kc.getUser(c.user);
      return {
        name: c.name,
        cluster: c.cluster,
        user: c.user,
        namespace: c.namespace ?? undefined,
        server: cluster?.server,
        current: c.name === current,
        health: handle?.health ?? cachedHealth?.health ?? 'unknown',
        healthMessage: handle?.healthMessage ?? cachedHealth?.healthMessage,
        active: !!handle,
        kubernetesVersion: handle?.kubernetesVersion ?? cachedHealth?.kubernetesVersion,
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
  async test(contextName: string): Promise<TestConnectionResponse> {
    if (!this.kc.getContexts().some((c) => c.name === contextName)) {
      throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
    }
    const result = await this.probeContext(contextName, BACKGROUND_HEALTH_TIMEOUT_MS);
    if (this.setCachedHealth(contextName, result)) this.emit('contexts-changed');
    return result;
  }

  private async probeContext(contextName: string, timeoutMs: number): Promise<TestConnectionResponse> {
    const kc = new KubeConfig();
    kc.loadFromString(this.kc.exportConfig());
    applyProxyRuntimeCompatibility(kc);
    kc.setCurrentContext(contextName);
    const raw = new RawClient(kc);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      const info = await raw.json<{ gitVersion?: string }>('/version', { signal: controller.signal });
      return { health: 'connected', kubernetesVersion: info.gitVersion };
    } catch (err) {
      const message = err instanceof Error && err.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : err instanceof Error ? err.message : String(err);
      return { health: 'error', healthMessage: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  private setCachedHealth(contextName: string, next: CachedContextHealth): boolean {
    const prev = this.healthCache.get(contextName);
    const cacheChanged = prev?.health !== next.health || prev.healthMessage !== next.healthMessage || prev.kubernetesVersion !== next.kubernetesVersion;
    const handle = this.handles.get(contextName);
    let handleChanged = false;
    if (handle?.activated) {
      handleChanged = handle.health !== next.health || handle.healthMessage !== next.healthMessage || handle.kubernetesVersion !== next.kubernetesVersion;
      handle.health = next.health;
      handle.healthMessage = next.healthMessage;
      handle.kubernetesVersion = next.kubernetesVersion;
    }
    if (cacheChanged) this.healthCache.set(contextName, next);
    return cacheChanged || handleChanged;
  }

  private refreshCachedHealth(): void {
    if (this.healthRun) return;
    this.healthRun = this.refreshCachedHealthNow().finally(() => {
      this.healthRun = undefined;
    });
  }

  private async refreshCachedHealthNow(): Promise<void> {
    const names = this.kc.getContexts().map((c) => c.name);
    if (!names.length) return;

    let changed = false;
    for (const name of names) {
      if (!this.healthCache.has(name) && !this.handles.has(name)) {
        changed = this.setCachedHealth(name, { health: 'connecting' }) || changed;
      }
    }
    if (changed) this.emit('contexts-changed');
    changed = false;

    let next = 0;
    const workers = Array.from({ length: Math.min(BACKGROUND_HEALTH_CONCURRENCY, names.length) }, async () => {
      for (;;) {
        const name = names[next++];
        if (name === undefined) return;
        const result = await this.probeContext(name, BACKGROUND_HEALTH_TIMEOUT_MS);
        if (this.kc.getContexts().some((c) => c.name === name)) {
          changed = this.setCachedHealth(name, result) || changed;
        }
      }
    });
    await Promise.all(workers);
    if (changed) this.emit('contexts-changed');
  }

  /**
   * Full edit of a context's cluster + user, persisted into the kubeconfig
   * files that define those entries (atomic write + backup), then reload so the
   * change takes effect on the next connect.
   */
  editCluster(contextName: string, patch: ClusterEditPatch): void {
    const ctxObj = this.kc.getContexts().find((c) => c.name === contextName);
    if (!ctxObj) throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
    const clusterName = ctxObj.cluster;
    if (!clusterName) throw new HttpProblem(400, `context "${contextName}" has no cluster reference`, 'BadRequest');

    const contextFile = this.findEntryFile('context', contextName);
    if (!contextFile) throw new HttpProblem(400, `could not find a kubeconfig file defining context "${contextName}"`, 'BadRequest');
    const clusterFile = this.findEntryFile('cluster', clusterName);
    if (!clusterFile) throw new HttpProblem(400, `could not find a kubeconfig file defining cluster "${clusterName}"`, 'BadRequest');

    const pendingWrites = new Map<string, string>();
    const readPending = (file: string) => pendingWrites.get(file) ?? fs.readFileSync(file, 'utf8');
    pendingWrites.set(clusterFile, patchClusterEntry(readPending(clusterFile), clusterName, patch));

    const editedUserName = patch.auth.method === 'keep' ? undefined : ctxObj.user;
    if (patch.auth.method !== 'keep') {
      if (!editedUserName) throw new HttpProblem(400, `context "${contextName}" has no user reference, so credentials can't be edited`, 'BadRequest');
      const userFile = this.findEntryFile('user', editedUserName);
      if (!userFile) throw new HttpProblem(400, `could not find a kubeconfig file defining user "${editedUserName}"`, 'BadRequest');
      pendingWrites.set(userFile, patchUserEntry(readPending(userFile), editedUserName, patch.auth));
    }

    for (const [file, content] of pendingWrites) {
      writeKubeconfig(file, content);
    }

    // Drop every active handle backed by the edited entries so reconnects use a
    // fresh KubeConfig clone.
    this.disconnectHandlesForEntries(clusterName, editedUserName);
    this.reload();
  }

  /** Locate the kubeconfig file (among the watched paths) that defines an entry. */
  private findEntryFile(kind: 'context' | 'cluster' | 'user', name: string | undefined): string | null {
    if (!name) return null;
    for (const p of this.kubeconfigPaths()) {
      try {
        const kc = new KubeConfig();
        kc.loadFromFile(p);
        if (kind === 'context' && kc.getContexts().some((c) => c.name === name)) return p;
        if (kind === 'cluster' && kc.getClusters().some((c) => c.name === name)) return p;
        if (kind === 'user' && kc.getUsers().some((u) => u.name === name)) return p;
      } catch {
        // unreadable / invalid file — skip
      }
    }
    return null;
  }

  private disconnectHandlesForEntries(clusterName: string, userName: string | undefined): void {
    const affected = new Set<string>();
    for (const c of this.kc.getContexts()) {
      if (c.cluster === clusterName || (userName && c.user === userName)) affected.add(c.name);
    }
    for (const contextName of affected) this.disconnect(contextName);
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
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const w of this.fsWatchers) w.close();
    for (const handle of this.handles.values()) handle.dispose();
    this.handles.clear();
  }
}
