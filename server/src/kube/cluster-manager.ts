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
  type ApiConstructor,
  type ApiType,
} from '@kubernetes/client-node';
import type { ContextInfo, TestConnectionResponse } from '@kubus/shared';
import { RawClient } from './raw-client.js';
import { DiscoveryCache } from './discovery.js';
import { WatcherRegistry } from './watcher.js';
import { MetricsPoller } from './metrics-poller.js';
import { NetworkMetricsPoller } from './network-poller.js';
import { ResourceSearchIndex } from './search-index.js';
import { applyEnvProxy, applyProxyRuntimeCompatibility, overrideClusterProxyUrl } from './connection.js';
import { patchClusterEntry, patchUserEntry, writeKubeconfig, type ClusterEditPatch } from './kubeconfig-file.js';
import { authTypeOf, authWarningForUser, describeProbeFailure } from './auth-diagnostics.js';
import { HttpProblem } from '../util/errors.js';
import type { SshTunnelManager } from '../ssh/tunnel-manager.js';
import { isValidSshDestination } from '../ssh/tunnel-manager.js';

const BACKGROUND_HEALTH_INTERVAL_MS = 60_000;
const BACKGROUND_HEALTH_TIMEOUT_MS = 8_000;
const BACKGROUND_HEALTH_CONCURRENCY = 4;

type CachedContextHealth = Pick<ContextInfo, 'health' | 'healthMessage' | 'kubernetesVersion'>;

/** Everything the server holds for one connected kubeconfig context. */
export class ClusterHandle {
  readonly kc: KubeConfig;
  readonly raw: RawClient;
  readonly discovery: DiscoveryCache;
  readonly watchers: WatcherRegistry;
  readonly metricsPoller: MetricsPoller;
  readonly networkPoller: NetworkMetricsPoller;
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
    sshProxyUrl?: string,
  ) {
    // Each handle owns its own KubeConfig: setCurrentContext mutates state
    // and exec-auth caches per-instance — never share across contexts.
    this.kc = new KubeConfig();
    this.kc.loadFromString(baseConfig.exportConfig());
    applyProxyRuntimeCompatibility(this.kc);
    this.kc.setCurrentContext(contextName);
    const clusterName = this.kc.getContexts().find((c) => c.name === contextName)?.cluster;
    if (sshProxyUrl && clusterName) overrideClusterProxyUrl(this.kc, clusterName, sshProxyUrl);
    this.raw = new RawClient(this.kc);
    this.discovery = new DiscoveryCache(this.raw);
    this.watchers = new WatcherRegistry(this.raw, log);
    this.metricsPoller = new MetricsPoller(new Metrics(this.kc), log);
    this.networkPoller = new NetworkMetricsPoller(this.raw, this.watchers, log);
    this.networkPoller.handle = this;
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
      const info = await this.raw.json<{ gitVersion?: string }>('/version');
      this.kubernetesVersion = info.gitVersion;
      this.health = 'connected';
      this.healthMessage = undefined;
    } catch (err) {
      this.health = 'error';
      this.healthMessage = await describeProbeFailure(err, this.kc.getCurrentUser(), this.raw);
    }
  }

  /** Start background machinery used by the overview dashboard + metrics. */
  activate(): void {
    if (this.activated) return;
    this.activated = true;
    this.metricsPoller.start();
    this.networkPoller.start();
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
    this.networkPoller.stop();
    this.watchers.stopAll();
    this.searchIndex.dispose();
  }
}

export class ClusterManager extends EventEmitter {
  private kc = new KubeConfig();
  private handles = new Map<string, ClusterHandle>();
  private connecting = new Map<string, Promise<ClusterHandle>>();
  private fsWatchers: fs.FSWatcher[] = [];
  private watchRetryTimers: NodeJS.Timeout[] = [];
  private reloadDebounce?: NodeJS.Timeout;
  private healthCache = new Map<string, CachedContextHealth>();
  private healthTimer?: NodeJS.Timeout;
  private healthRun?: Promise<void>;
  /**
   * Long-lived per-context clients for health probes. Reusing them keeps the
   * exec-plugin token cache and TLS connection pool warm instead of spawning
   * cloud CLIs and re-handshaking on every probe cycle.
   */
  private probeClients = new Map<string, { raw: RawClient; proxyUrl?: string }>();
  /** Cluster names whose proxy-url was injected from env vars (not the kubeconfig). */
  private envProxyClusters = new Set<string>();

  constructor(
    private log: FastifyBaseLogger,
    private kubeconfigOverride?: string,
    private sshTunnels?: SshTunnelManager,
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
    this.closeFileWatchers();
    this.reload();
    this.watchKubeconfigFiles();
  }

  private closeFileWatchers(): void {
    for (const w of this.fsWatchers) w.close();
    this.fsWatchers = [];
    for (const t of this.watchRetryTimers) clearTimeout(t);
    this.watchRetryTimers = [];
  }

  /**
   * Watch the parent directories of the kubeconfig paths rather than the files
   * themselves: fs.watch on a file goes stale once the file is replaced via
   * tmp+rename (which is how kubectl — and our own writeKubeconfig — save it),
   * and a directory watch also picks up kubeconfigs created after startup.
   */
  private watchKubeconfigFiles(): void {
    const byDir = new Map<string, Set<string>>();
    for (const p of this.kubeconfigPaths()) {
      const abs = path.resolve(p);
      const dir = path.dirname(abs);
      let names = byDir.get(dir);
      if (!names) byDir.set(dir, (names = new Set()));
      names.add(path.basename(abs));
    }
    for (const [dir, names] of byDir) this.watchKubeconfigDir(dir, names);
  }

  private watchKubeconfigDir(dir: string, names: Set<string>): void {
    try {
      const w = fs.watch(dir, (_event, filename) => {
        // A null filename (possible on some platforms) may still concern us.
        if (filename && !names.has(filename.toString())) return;
        this.scheduleReload();
      });
      w.unref();
      this.fsWatchers.push(w);
    } catch {
      // Directory missing (e.g. ~/.kube on a fresh machine) — retry until it appears.
      const timer = setTimeout(() => {
        this.watchRetryTimers = this.watchRetryTimers.filter((t) => t !== timer);
        this.watchKubeconfigDir(dir, names);
      }, 10_000);
      timer.unref();
      this.watchRetryTimers.push(timer);
    }
  }

  private scheduleReload(): void {
    if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    this.reloadDebounce = setTimeout(() => {
      this.reloadDebounce = undefined;
      this.reload();
    }, 300);
    this.reloadDebounce.unref();
  }

  /** Serialized (context, cluster, user) per context — for change detection across reloads. */
  private contextFingerprints(): Map<string, string> {
    const map = new Map<string, string>();
    for (const c of this.kc.getContexts()) {
      map.set(c.name, JSON.stringify([c, this.kc.getCluster(c.cluster) ?? null, this.kc.getUser(c.user) ?? null]));
    }
    return map;
  }

  reload(): void {
    this.log.info('kubeconfig changed, reloading');
    const before = this.contextFingerprints();
    this.kc = new KubeConfig();
    this.loadKubeconfig();
    this.probeClients.clear();
    const after = this.contextFingerprints();
    for (const [name, handle] of this.handles) {
      // Drop sessions whose backing entries were removed or edited so clients
      // reconnect against the new definition instead of a stale clone.
      if (after.get(name) === before.get(name)) continue;
      handle.dispose();
      this.handles.delete(name);
      this.healthCache.delete(name);
      this.emit('context-reset', name);
    }
    for (const name of this.healthCache.keys()) {
      if (!after.has(name)) this.healthCache.delete(name);
    }
    this.refreshCachedHealth();
    this.emit('contexts-changed');
  }

  listContexts(): ContextInfo[] {
    const current = this.kc.getCurrentContext();
    const contextFiles = this.contextFilesByName();
    return this.kc.getContexts().map((c) => {
      const handle = this.handles.get(c.name);
      const cachedHealth = this.healthCache.get(c.name);
      const cluster = this.kc.getCluster(c.cluster);
      const user = this.kc.getUser(c.user);
      const contextFile = contextFiles.get(c.name);
      const sshTunnelKey = contextFile ? sshTunnelKeyFor(contextFile, c.name) : null;
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
        sshHost: sshTunnelKey ? this.sshTunnels?.hostForContextKey(sshTunnelKey) : undefined,
        tlsServerName: cluster?.tlsServerName,
        skipTlsVerify: cluster?.skipTLSVerify || undefined,
        caPresent: !!(cluster?.caData || cluster?.caFile) || undefined,
        authType: authTypeOf(user),
        authWarning: authWarningForUser(user),
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

  /** SOCKS URL of the managed SSH tunnel for a context, spawning the tunnel if needed. */
  private async sshProxyFor(contextName: string): Promise<string | undefined> {
    if (!this.sshTunnels) return undefined;
    const sshTunnelKey = this.sshTunnelKeyForContext(contextName);
    if (!sshTunnelKey) return undefined;
    const host = this.sshTunnels.hostForContextKey(sshTunnelKey);
    if (!host) return undefined;
    return this.sshTunnels.ensure(host);
  }

  private async probeClient(contextName: string): Promise<RawClient> {
    // For SSH-tunneled clusters the proxy URL can move (tunnel respawned on a
    // new port), so the cached client is only valid while the URL matches.
    const sshProxyUrl = await this.sshProxyFor(contextName);
    const cached = this.probeClients.get(contextName);
    if (cached && cached.proxyUrl === sshProxyUrl) return cached.raw;
    const kc = new KubeConfig();
    kc.loadFromString(this.kc.exportConfig());
    applyProxyRuntimeCompatibility(kc);
    kc.setCurrentContext(contextName);
    const clusterName = kc.getContexts().find((c) => c.name === contextName)?.cluster;
    if (sshProxyUrl && clusterName) overrideClusterProxyUrl(kc, clusterName, sshProxyUrl);
    const raw = new RawClient(kc);
    this.probeClients.set(contextName, { raw, proxyUrl: sshProxyUrl });
    return raw;
  }

  private async probeContext(contextName: string, timeoutMs: number): Promise<TestConnectionResponse> {
    const userName = this.kc.getContexts().find((c) => c.name === contextName)?.user;
    const user = userName ? this.kc.getUser(userName) : null;
    let raw: RawClient;
    try {
      raw = await this.probeClient(contextName);
    } catch (err) {
      return { health: 'error', healthMessage: await describeProbeFailure(err, user) };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      const info = await raw.json<{ gitVersion?: string }>('/version', { signal: controller.signal });
      return { health: 'connected', kubernetesVersion: info.gitVersion };
    } catch (err) {
      const message = err instanceof Error && err.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : await describeProbeFailure(err, user, raw);
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

  /**
   * Set or clear the Kubus-managed SSH jump host for a context's cluster.
   * Persisted in Kubus settings (not the kubeconfig); affected sessions are
   * dropped so the next connect goes through (or stops using) the tunnel.
   */
  setSshHost(contextName: string, host: string | null): void {
    const ctxObj = this.kc.getContexts().find((c) => c.name === contextName);
    if (!ctxObj) throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
    if (!ctxObj.cluster) throw new HttpProblem(400, `context "${contextName}" has no cluster reference`, 'BadRequest');
    if (!this.sshTunnels) throw new HttpProblem(500, 'SSH tunnel support is not available in this server', 'SshUnavailable');
    if (host && !isValidSshDestination(host)) {
      throw new HttpProblem(400, 'SSH jump host must be an ssh config alias or user@host (no spaces or leading "-")', 'BadRequest');
    }
    const sshTunnelKey = this.sshTunnelKeyForContext(contextName);
    if (!sshTunnelKey) throw new HttpProblem(400, `could not find a kubeconfig file defining context "${contextName}"`, 'BadRequest');
    if ((this.sshTunnels.hostForContextKey(sshTunnelKey) ?? null) === host) return;
    this.sshTunnels.setHostForContextKey(sshTunnelKey, host);
    this.disconnect(contextName);
    this.probeClients.delete(contextName);
    this.refreshCachedHealth();
    this.emit('contexts-changed');
  }

  private sshTunnelKeyForContext(contextName: string): string | null {
    const contextFile = this.findEntryFile('context', contextName);
    if (!contextFile) return null;
    return sshTunnelKeyFor(contextFile, contextName);
  }

  /** The kubeconfig file defining each context, loading every watched path once. */
  private contextFilesByName(): Map<string, string> {
    const files = new Map<string, string>();
    for (const p of this.kubeconfigPaths()) {
      try {
        const kc = new KubeConfig();
        kc.loadFromFile(p);
        for (const c of kc.getContexts()) {
          if (!files.has(c.name)) files.set(c.name, p);
        }
      } catch {
        // unreadable / invalid file — skip
      }
    }
    return files;
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
    const inFlight = this.connecting.get(contextName);
    if (inFlight) return inFlight;
    const connecting = this.connectFresh(contextName).finally(() => {
      if (this.connecting.get(contextName) === connecting) this.connecting.delete(contextName);
    });
    this.connecting.set(contextName, connecting);
    return connecting;
  }

  private async connectFresh(contextName: string): Promise<ClusterHandle> {
    const ctxEntry = this.kc.getContexts().find((c) => c.name === contextName);
    if (!ctxEntry) {
      throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
    }
    let sshProxyUrl: string | undefined;
    try {
      sshProxyUrl = await this.sshProxyFor(contextName);
    } catch (err) {
      throw new HttpProblem(502, err instanceof Error ? err.message : String(err), 'SshTunnelFailed');
    }
    const handle = new ClusterHandle(this.kc, contextName, this.log, sshProxyUrl);
    this.handles.set(contextName, handle);
    await handle.probe();
    if (handle.health === 'connected') {
      handle.activate();
    }
    // A fresh session exists: watch subscriptions must (re)attach to it.
    this.emit('context-reset', contextName);
    this.emit('contexts-changed');
    return handle;
  }

  disconnect(contextName: string): void {
    const handle = this.handles.get(contextName);
    if (handle) {
      handle.dispose();
      this.handles.delete(contextName);
      this.emit('context-reset', contextName);
      this.emit('contexts-changed');
    }
  }

  /**
   * Tear down a context's session and build a fresh one: new KubeConfig clone,
   * new auth state, discovery, watchers, and metrics. The user-facing "my
   * session is stuck / my credentials rotated" escape hatch.
   */
  async reconnect(contextName: string): Promise<ClusterHandle> {
    this.disconnect(contextName);
    this.probeClients.delete(contextName);
    return this.connect(contextName);
  }

  dispose(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    this.closeFileWatchers();
    for (const handle of this.handles.values()) handle.dispose();
    this.handles.clear();
  }
}

function sshTunnelKeyFor(contextFile: string, contextName: string): string {
  return `context:${JSON.stringify([path.resolve(contextFile), contextName])}`;
}
