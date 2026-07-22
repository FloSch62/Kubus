import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';

const harness = vi.hoisted(() => {
  const cache = new Map<string, unknown>();
  const queryClient = {
    invalidateQueries: vi.fn((_filters?: { predicate?: (query: { queryKey: unknown[] }) => boolean }) => Promise.resolve()),
    setQueryData: vi.fn((key: readonly unknown[], value: unknown) => {
      const cacheKey = JSON.stringify(key);
      const next = typeof value === 'function' ? (value as (current: unknown) => unknown)(cache.get(cacheKey)) : value;
      cache.set(cacheKey, next);
      return next;
    }),
  };
  const value = {
    apiFetch: vi.fn(),
    queryConfigs: [] as unknown[],
    mutationConfigs: [] as unknown[],
    multiQueryConfigs: [] as unknown[],
    queryResults: new Map<string, { data?: unknown; isLoading?: boolean; error?: unknown }>(),
    cache,
    queryClient,
    broadcastHandlers: new Set<(message: unknown) => void>(),
    subscriptions: [] as Array<{
      params: unknown;
      handlers: {
        onSnapshot(items: KubeObject[]): void;
        onEvents(events: Array<{ type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: KubeObject }>): void;
        onStatus(state: 'live' | 'reconnecting' | 'error', message?: string): void;
      };
      unsubscribe: ReturnType<typeof vi.fn>;
    }>,
    paneActive: true,
    showToast: vi.fn(),
  };
  Reflect.set(globalThis, Symbol.for('kubus.test.query-harness'), value);
  return value;
});

vi.mock('../../../client/src/api/http.js', () => ({ apiFetch: harness.apiFetch }));
vi.mock('../../../client/src/layout/pane-context.js', () => ({ usePaneActive: () => harness.paneActive }));
vi.mock('../../../client/src/state/prefs.js', () => ({
  useRefetchInterval: (base: number) => base,
  useUiPrefsStore: vi.fn(),
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: harness.showToast }));
vi.mock('../../../client/src/api/ws/watch-client.js', () => ({
  watchClient: {
    onBroadcast: (handler: (message: unknown) => void) => {
      harness.broadcastHandlers.add(handler);
      return () => harness.broadcastHandlers.delete(handler);
    },
    subscribe: (
      params: unknown,
      handlers: {
        onSnapshot(items: KubeObject[]): void;
        onEvents(events: Array<{ type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: KubeObject }>): void;
        onStatus(state: 'live' | 'reconnecting' | 'error', message?: string): void;
      },
    ) => {
      const unsubscribe = vi.fn();
      harness.subscriptions.push({ params, handlers, unsubscribe });
      return unsubscribe;
    },
  },
}));

import * as queries from '../../../client/src/api/queries';
import { useClustersStore } from '../../../client/src/state/clusters';

interface CapturedConfig {
  queryKey?: readonly unknown[];
  queryFn?: (...args: unknown[]) => unknown;
  mutationFn?: (...args: unknown[]) => unknown;
  onSuccess?: (...args: unknown[]) => unknown;
  onSettled?: (...args: unknown[]) => unknown;
  refetchInterval?: number | false | ((query: { state: { data?: unknown } }) => number | false);
}

function config(value: unknown): CapturedConfig {
  return value as CapturedConfig;
}

function kubeObject(name: string, namespace = 'team-a'): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, uid: `uid-${name}`, resourceVersion: '1' },
  };
}

function emitBroadcast(message: unknown): void {
  for (const handler of harness.broadcastHandlers) handler(message);
}

function responseFor(url: string): unknown {
  if (url.endsWith('/api-resources')) {
    return [
      { group: '', version: 'v1', plural: 'pods', kind: 'Pod', namespaced: true, verbs: ['get', 'list'], shortNames: ['po'] },
      { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['get'] },
    ];
  }
  if (url.endsWith('/namespaces')) return ['team-b', 'team-a'];
  if (url.includes('/search?')) return [{ title: 'Pod demo', score: 10 }, { title: 'Deployment web', score: 5 }];
  if (url.endsWith('/helm/releases')) return [{ name: 'demo', namespace: 'team-a' }];
  if (url.includes('/resources/')) return { items: [kubeObject('listed')] };
  if (url.includes('/metrics/')) return { available: true, probed: true, items: [] };
  if (url.endsWith('/graph') || url.includes('/graph?')) return { ctx: 'dev', nodes: [], edges: [], warnings: [] };
  if (url.includes('/audit')) return { findings: [] };
  return {};
}

beforeEach(() => {
  harness.queryConfigs.length = 0;
  harness.mutationConfigs.length = 0;
  harness.multiQueryConfigs.length = 0;
  harness.queryResults.clear();
  harness.cache.clear();
  harness.broadcastHandlers.clear();
  harness.subscriptions.length = 0;
  harness.paneActive = true;
  harness.queryClient.invalidateQueries.mockClear();
  harness.queryClient.setQueryData.mockClear();
  harness.showToast.mockClear();
  harness.apiFetch.mockReset();
  harness.apiFetch.mockImplementation((url: string) => Promise.resolve(responseFor(url)));
  useClustersStore.setState({ selected: ['dev'], namespaces: ['team-a'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('query hook contracts', () => {
  it('registers every query and executes each request contract', async () => {
    const { result, unmount } = renderHook(() => ({
      contextsInvalidation: queries.useContextsInvalidation(),
      contexts: queries.useContexts(),
      contextsNoPoll: queries.useContexts({ poll: false }),
      clusterCa: queries.useClusterCa('dev/x', true),
      sshInfo: queries.useSshInfo(),
      kubeconfigSettings: queries.useKubeconfigSettings(),
      apiResources: queries.useApiResources('dev/x'),
      resourcesForContexts: queries.useApiResourcesForContexts(['dev/x', 'prod']),
      namespaces: queries.useNamespaces(['dev/x', 'prod']),
      resource: queries.useResource(
        { ctx: 'dev/x', group: 'apps', version: 'v1', plural: 'deployments', name: 'web/a', namespace: 'team a', reveal: true },
        { liveMs: 2_000 },
      ),
      schema: queries.useResourceSchema({ ctx: 'dev/x', group: 'apps', version: 'v1', kind: 'Deployment' }),
      resourceList: queries.useResourceList({
        ctx: 'dev/x',
        group: 'apps',
        version: 'v1',
        plural: 'deployments',
        namespace: 'team a',
        labelSelector: 'app=web',
        fieldSelector: 'metadata.name=web',
      }),
      events: queries.useResourceEvents({ ctx: 'dev/x', name: 'web/a', kind: 'Pod', namespace: 'team a' }),
      podEnv: queries.usePodEnv({ ctx: 'dev/x', namespace: 'team a', name: 'pod/a', reveal: true }),
      secretTls: queries.useSecretTls({ ctx: 'dev/x', namespace: 'team a', name: 'secret/a' }),
      rolloutHistory: queries.useRolloutHistory({ ctx: 'dev/x', kind: 'Deployment', namespace: 'team a', name: 'web/a' }),
      crdColumns: queries.useCrdColumns('dev/x', 'example.test', 'v1', 'widgets', true),
      nodeMetrics: queries.useNodeMetrics('dev/x'),
      resourceMetrics: queries.useResourceMetrics(['dev/x', 'prod'], 'pods'),
      metricsHistory: queries.useMetricsHistory({ ctx: 'dev/x', kind: 'pod', namespace: 'team a', name: 'pod/a' }),
      metricsSummary: queries.useMetricsSummary('dev/x'),
      metricsStatus: queries.useMetricsServerStatus('dev/x'),
      networkSummary: queries.useNetworkSummary('dev/x'),
      networkStatus: queries.useNetworkAgentStatus('dev/x'),
      overview: queries.useOverview('dev/x'),
      operators: queries.useOverviewOperators('dev/x', ['team-b', 'team-a']),
      certificates: queries.useOverviewCertificates('dev/x', ['team-b', 'team-a']),
      podResources: queries.usePodResources('dev/x', 'team a'),
      namespaceOverview: queries.useNamespaceOverview('dev/x', ['team-b', 'team-a']),
      audit: queries.useAudit(['dev/x', 'prod']),
      search: queries.useGlobalSearch(['dev/x', 'prod'], '  web  '),
      topology: queries.useTopologyGraphs(
        ['dev/x', 'prod'],
        ['team-a'],
        { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', name: 'web/a', namespace: 'team a', depth: 3 },
      ),
      helmReleases: queries.useHelmReleases(['dev/x', 'prod']),
      helmRelease: queries.useHelmRelease('dev/x', 'team a', 'release/a'),
      helmHistory: queries.useHelmHistory('dev/x', 'team a', 'release/a'),
      helmOperations: queries.useHelmOperations(),
      helmEvents: queries.useHelmOperationEvents(),
      helmRevision: queries.useHelmRevision('dev/x', 'team a', 'release/a', 2),
      appInfo: queries.useAppInfo(),
      helmRepos: queries.useHelmRepos(),
      repoCharts: queries.useHelmRepoCharts('stable/repo'),
      chartVersions: queries.useHelmChartVersions('stable/repo', 'chart/a'),
      chartDetail: queries.useHelmChartDetail('stable/repo', 'chart/a', '1.2.3'),
      chartFind: queries.useHelmChartFind('chart/a'),
      helmUpdates: queries.useHelmUpdates([{ ctx: 'dev/x', namespace: 'team a', name: 'release/a', chart: 'chart/a' }] as never),
      hubSearch: queries.useHelmHubSearch('web chart'),
      hubVersions: queries.useHelmHubVersions('repo/a', 'chart/a'),
      chartDetailByUrl: queries.useHelmChartDetailByUrl('https://charts.example.test/a', 'chart/a', '1.2.3'),
      ociDetail: queries.useHelmOciDetail('oci://registry.example.test/chart/a', '1.2.3'),
      sourceDetail: queries.useHelmChartSourceDetail({ type: 'repo', repo: 'stable/repo', chart: 'chart/a', version: '1.2.3' } as never),
      portForwards: queries.usePortForwards(),
      portPreflight: queries.usePortForwardPreflight({ ctx: 'dev/x', namespace: 'team a' }),
    }));

    expect(result.current.contexts).toMatchObject({ queryKey: ['contexts'] });
    expect(config(result.current.contextsNoPoll).refetchInterval).toBe(false);
    expect(result.current.resourceMetrics).toMatchObject({ data: expect.any(Map) });
    expect(harness.queryConfigs.length).toBeGreaterThan(45);

    for (const captured of harness.queryConfigs.map(config)) {
      if (captured.queryFn) await expect(Promise.resolve(captured.queryFn({}))).resolves.not.toThrow();
    }
    for (const captured of harness.multiQueryConfigs as Array<{ queries: CapturedConfig[] }>) {
      for (const query of captured.queries) await expect(Promise.resolve(query.queryFn?.({}))).resolves.not.toThrow();
    }

    const calledUrls = harness.apiFetch.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).toContain('/api/contexts/dev%2Fx/cluster-ca'.replace('cluster-ca', 'ca'));
    expect(calledUrls).toContain(
      '/api/contexts/dev%2Fx/resources/apps/v1/deployments/web%2Fa?namespace=team+a&reveal=true',
    );
    expect(calledUrls).toContain(
      '/api/contexts/dev%2Fx/resources/apps/v1/deployments?namespace=team+a&labelSelector=app%3Dweb&fieldSelector=metadata.name%3Dweb',
    );
    expect(calledUrls.some((url) => url.includes('/graph?namespace=team-a&focusGroup=apps'))).toBe(true);

    const metricsPoll = harness.queryConfigs.map(config).find((item) => item.queryKey?.[0] === 'metrics-server-status');
    expect(typeof metricsPoll?.refetchInterval).toBe('function');
    const metricsInterval = metricsPoll?.refetchInterval as (query: { state: { data?: unknown } }) => number;
    expect(metricsInterval({ state: { data: { installed: true, ready: false, metricsAvailable: false } } })).toBe(5_000);
    expect(metricsInterval({ state: { data: { installed: true, ready: true, metricsAvailable: true } } })).toBe(30_000);

    const networkPoll = harness.queryConfigs.map(config).find((item) => item.queryKey?.[0] === 'network-agent-status');
    const networkInterval = networkPoll?.refetchInterval as (query: { state: { data?: unknown } }) => number;
    expect(networkInterval({ state: { data: { installed: true, ready: true, metricsAvailable: true, nodesReady: 1, nodesDesired: 2 } } })).toBe(5_000);
    expect(networkInterval({ state: { data: { installed: false } } })).toBe(30_000);

    const operationsPoll = harness.queryConfigs.map(config).find((item) => item.queryKey?.[0] === 'helm-operations');
    const operationsInterval = operationsPoll?.refetchInterval as (query: { state: { data?: unknown } }) => number;
    expect(operationsInterval({ state: { data: [{ status: 'running' }] } })).toBe(2_000);
    expect(operationsInterval({ state: { data: [{ status: 'succeeded' }] } })).toBe(30_000);

    unmount();
    expect(harness.broadcastHandlers.size).toBe(0);
  });

  it('registers every mutation, sends its request, and runs cache callbacks', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => ({
      connect: queries.useConnectContext(),
      reconnect: queries.useReconnectContext(),
      testConnection: queries.useTestConnection(),
      editCluster: queries.useEditCluster(),
      deleteCluster: queries.useDeleteCluster(),
      setSsh: queries.useSetSshHost(),
      setKubeconfig: queries.useSetKubeconfig(),
      importKubeconfig: queries.useImportKubeconfig(),
      apply: queries.useApplyResource(),
      create: queries.useCreateResource(),
      dryRun: queries.useDryRunResource(),
      deleteResource: queries.useDeleteResource(),
      scale: queries.useScale(),
      restart: queries.useRolloutRestart(),
      cordon: queries.useCordon(),
      drain: queries.useDrain(),
      suspend: queries.useSuspendCronJob(),
      setImage: queries.useSetImage(),
      rerun: queries.useRerunJob(),
      undo: queries.useRolloutUndo(),
      pause: queries.useRolloutPause(),
      debug: queries.useDebugPod(),
      stopDebug: queries.useStopDebug(),
      installMetrics: queries.useInstallMetricsServer(),
      uninstallMetrics: queries.useUninstallMetricsServer(),
      installNetwork: queries.useInstallNetworkAgent(),
      uninstallNetwork: queries.useUninstallNetworkAgent(),
      helmUninstall: queries.useHelmUninstall(),
      helmRollback: queries.useHelmRollback(),
      addRepo: queries.useAddHelmRepo(),
      removeRepo: queries.useRemoveHelmRepo(),
      helmUpgrade: queries.useHelmUpgrade(),
      helmUpgradeDry: queries.useHelmUpgradeDryRun(),
      helmInstall: queries.useHelmInstall(),
      helmInstallDry: queries.useHelmInstallDryRun(),
      startPort: queries.useStartPortForward(),
      stopPort: queries.useStopPortForward(),
      stopAllPorts: queries.useStopAllPortForwards(),
    }));

    const actionBody = { namespace: 'team a', name: 'web/a', kind: 'Deployment' };
    const cases: Array<[keyof typeof result.current, unknown, unknown?]> = [
      ['connect', { ctx: 'dev/x', connect: true }, []],
      ['reconnect', 'dev/x', []],
      ['testConnection', 'dev/x'],
      ['editCluster', { ctx: 'dev/x', body: { name: 'renamed' } }, []],
      ['deleteCluster', 'dev/x', []],
      ['setSsh', { ctx: 'dev/x', body: { host: 'jump/a' } }, []],
      ['setKubeconfig', { path: '/tmp/kube config' }, { path: '/tmp/kube config' }],
      ['importKubeconfig', { contents: 'apiVersion: v1' }, { contexts: [] }],
      ['apply', { ctx: 'dev/x', group: 'apps', version: 'v1', plural: 'deployments', name: 'web/a', namespace: 'team a', yamlBody: 'kind: Deployment' }],
      ['create', { ctx: 'dev/x', yamlBody: 'kind: Pod' }],
      ['dryRun', { ctx: 'dev/x', yamlBody: 'kind: Pod' }],
      ['deleteResource', { ctx: 'dev/x', group: '', version: 'v1', plural: 'pods', name: 'pod/a', namespace: 'team a' }],
      ['scale', { ctx: 'dev/x', body: actionBody }],
      ['restart', { ctx: 'dev/x', body: actionBody }],
      ['cordon', { ctx: 'dev/x', body: actionBody }],
      ['drain', { ctx: 'dev/x', body: actionBody }],
      ['suspend', { ctx: 'dev/x', body: actionBody }],
      ['setImage', { ctx: 'dev/x', body: actionBody }],
      ['rerun', { ctx: 'dev/x', body: actionBody }],
      ['undo', { ctx: 'dev/x', body: actionBody }],
      ['pause', { ctx: 'dev/x', body: actionBody }],
      ['debug', { ctx: 'dev/x', body: actionBody }],
      ['stopDebug', { ctx: 'dev/x', body: actionBody }],
      ['installMetrics', { ctx: 'dev/x', body: { insecureTls: true } }],
      ['uninstallMetrics', { ctx: 'dev/x' }],
      ['installNetwork', { ctx: 'dev/x' }],
      ['uninstallNetwork', { ctx: 'dev/x' }],
      ['helmUninstall', { ctx: 'dev/x', ns: 'team a', name: 'release/a', skipHooks: true, deleteCrds: true }],
      ['helmRollback', { ctx: 'dev/x', ns: 'team a', name: 'release/a', revision: 2, skipHooks: true, wait: true, timeoutSeconds: 60 }],
      ['addRepo', { name: 'repo/a', url: 'https://charts.example.test/a' }],
      ['removeRepo', 'repo/a'],
      ['helmUpgrade', { ctx: 'dev/x', ns: 'team a', name: 'release/a', values: { replicas: 2 }, wait: true }],
      ['helmUpgradeDry', { ctx: 'dev/x', ns: 'team a', name: 'release/a', values: { replicas: 2 } }],
      ['helmInstall', { ctx: 'dev/x', namespace: 'team a', releaseName: 'release/a', chart: { type: 'repo' }, values: {} }],
      ['helmInstallDry', { ctx: 'dev/x', namespace: 'team a', releaseName: 'release/a', chart: { type: 'repo' }, values: {} }],
      ['startPort', { ctx: 'dev/x', body: { namespace: 'team a', pod: 'pod/a', remotePort: 8080 } }],
      ['stopPort', 'forward/a'],
      ['stopAllPorts', undefined],
    ];

    for (const [name, vars, success = {}] of cases) {
      const captured = config(result.current[name]);
      expect(captured.mutationFn, String(name)).toBeTypeOf('function');
      await expect(Promise.resolve(captured.mutationFn?.(vars))).resolves.not.toThrow();
      captured.onSuccess?.(success, vars, undefined);
      captured.onSettled?.(success, null, vars, undefined);
    }
    vi.advanceTimersByTime(1_500);

    const requests = harness.apiFetch.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit | undefined }));
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: '/api/contexts/dev%2Fx/connect', init: expect.objectContaining({ method: 'POST' }) }),
        expect.objectContaining({ url: '/api/contexts/dev%2Fx/actions/rollout-restart' }),
        expect.objectContaining({ url: '/api/contexts/dev%2Fx/helm/releases/team%20a/release%2Fa?skipHooks=true&deleteCrds=true' }),
        expect.objectContaining({ url: '/api/portforwards/forward%2Fa', init: expect.objectContaining({ method: 'DELETE' }) }),
      ]),
    );
    expect(harness.queryClient.invalidateQueries).toHaveBeenCalled();
    expect(harness.queryClient.setQueryData).toHaveBeenCalled();
  });

  it('handles context, discovery, Helm-operation, and port-forward broadcasts', () => {
    const running = {
      id: 'op-1',
      ctx: 'dev',
      namespace: 'team-a',
      releaseName: 'demo',
      kind: 'upgrade',
      status: 'running',
      phase: 'rendering',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    harness.cache.set(JSON.stringify(['helm-operations']), [running]);
    const { unmount } = renderHook(() => {
      queries.useContextsInvalidation();
      queries.useHelmOperationEvents();
      queries.usePortForwards();
    });

    emitBroadcast({ op: 'contexts-changed' });
    emitBroadcast({ op: 'discovery-update', ctx: 'dev' });
    emitBroadcast({ op: 'pf-update', forwards: [{ id: 'pf-1' }] });
    emitBroadcast({
      op: 'helm-operation',
      operation: { ...running, status: 'succeeded', phase: 'done', revision: 2, finishedAt: '2026-01-01T00:01:00.000Z' },
    });
    expect(harness.showToast).toHaveBeenCalledWith('success', expect.stringContaining('upgrade completed'));

    harness.cache.set(JSON.stringify(['helm-operations']), [running]);
    emitBroadcast({
      op: 'helm-operation',
      operation: { ...running, status: 'failed', phase: 'done', error: 'boom', finishedAt: '2026-01-01T00:01:00.000Z' },
    });
    emitBroadcast({ op: 'unrelated' });

    expect(harness.showToast).toHaveBeenCalledWith('error', expect.stringContaining('upgrade failed'));
    expect(harness.cache.get(JSON.stringify(['portforwards']))).toEqual([{ id: 'pf-1' }]);
    expect(harness.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['contexts'] });
    expect(harness.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['api-resources', 'dev'] });
    unmount();
  });
});

describe('watched and filtered lists', () => {
  it('applies snapshots, deltas, statuses, and defers hidden-pane commits', () => {
    const first = kubeObject('first');
    const second = kubeObject('second');
    const { result, rerender, unmount } = renderHook(() => queries.useWatchedList(['dev'], 'apps', 'v1', 'deployments'));
    const sub = harness.subscriptions[0]!;
    expect(sub.params).toEqual({ ctx: 'dev', group: 'apps', version: 'v1', plural: 'deployments' });

    act(() => sub.handlers.onSnapshot([first]));
    expect(result.current.rows.map((item) => item.obj.metadata.name)).toEqual(['first']);
    act(() => sub.handlers.onStatus('live'));
    expect(result.current.status.dev).toEqual({ state: 'live', message: undefined });
    act(() => sub.handlers.onStatus('live'));

    act(() => sub.handlers.onEvents([{ type: 'ADDED', object: second }]));
    expect(result.current.rows).toHaveLength(2);
    act(() => sub.handlers.onEvents([{ type: 'MODIFIED', object: { ...second, metadata: { ...second.metadata, resourceVersion: '2' } } }]));
    act(() => sub.handlers.onEvents([{ type: 'DELETED', object: first }]));
    expect(result.current.rows.map((item) => item.obj.metadata.name)).toEqual(['second']);

    harness.paneActive = false;
    rerender();
    act(() => sub.handlers.onSnapshot([first]));
    expect(result.current.rows[0]?.obj.metadata.name).toBe('second');
    harness.paneActive = true;
    rerender();
    expect(result.current.rows[0]?.obj.metadata.name).toBe('first');

    unmount();
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
  });

  it('filters watched rows by namespace and returns selector-query results', () => {
    useClustersStore.setState({ selected: ['dev'], namespaces: ['team-a'] });
    const plain = renderHook(() => queries.useFilteredList('', 'v1', 'pods', true));
    const plainSub = harness.subscriptions[0]!;
    act(() => plainSub.handlers.onSnapshot([kubeObject('visible', 'team-a'), kubeObject('hidden', 'team-b')]));
    expect(plain.result.current.rows.map((item) => item.obj.metadata.name)).toEqual(['visible']);
    plain.unmount();

    const selectorKey = JSON.stringify(['selector-list', ['dev'], ['team-a'], '', 'v1', 'pods', { labelSelector: ' app=web ' }]);
    harness.queryResults.set(selectorKey, { data: [{ ctx: 'dev', obj: kubeObject('selected') }] });
    const selected = renderHook(() => queries.useFilteredList('', 'v1', 'pods', true, { labelSelector: ' app=web ' }));
    expect(selected.result.current.rows.map((item) => item.obj.metadata.name)).toEqual(['selected']);
    expect(selected.result.current.status.dev).toEqual({ state: 'live', message: undefined });
    selected.unmount();
  });
});

describe('standalone query helpers', () => {
  it('builds resource, log-target, topology, and local-port requests', async () => {
    expect(queries.resourceUrl('dev/x', '', 'v1', 'pods', 'pod/a', 'team a', { reveal: 'true' })).toBe(
      '/api/contexts/dev%2Fx/resources/core/v1/pods/pod%2Fa?namespace=team+a&reveal=true',
    );
    await queries.resolveLogTargetPods({
      ctx: 'dev/x',
      group: 'apps',
      version: 'v1',
      plural: 'deployments',
      kind: 'Deployment',
      namespace: 'team a',
      name: 'web/a',
    });
    await queries.checkLocalPort(8080);

    const topology = queries.topologyGraphsOptions(
      ['dev/x'],
      ['team-a', 'team-b'],
      { group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: 'pod/a' },
    ) as CapturedConfig;
    await topology.queryFn?.();
    expect(harness.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/detail/log-target-pods?group=apps'));
    expect(harness.apiFetch).toHaveBeenCalledWith('/api/portforwards/port-check?port=8080');
    expect(harness.apiFetch).toHaveBeenCalledWith(expect.stringContaining('depth=2'));
  });

  it('scopes metrics invalidation predicates to the requested context', () => {
    queries.invalidateMetricsServer(harness.queryClient as never, 'dev');
    const calls = harness.queryClient.invalidateQueries.mock.calls.map(([arg]) => arg as { predicate?: (query: { queryKey: unknown[] }) => boolean });
    const predicates = calls.flatMap((arg) => (arg.predicate ? [arg.predicate] : []));
    expect(predicates).toHaveLength(2);
    expect(predicates[0]?.({ queryKey: ['metrics-snapshot', 'pods', 'dev'] })).toBe(true);
    expect(predicates[0]?.({ queryKey: ['metrics-snapshot', 'pods', 'prod'] })).toBe(false);
    expect(predicates[1]?.({ queryKey: ['metrics-history', { ctx: 'dev' }] })).toBe(true);
    expect(predicates[1]?.({ queryKey: ['metrics-history', { ctx: 'prod' }] })).toBe(false);
  });
});
