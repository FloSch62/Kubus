import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, queryOptions, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePaneActive } from '../layout/pane-context.js';
import type {
  ClusterMetricsSummary,
  ClusterOverview,
  ContextInfo,
  HelmReleaseDetail,
  HelmReleaseSummary,
  HelmRevision,
  KubeObject,
  LogTargetKind,
  LogTargetPodsResponse,
  MetricsHistoryResponse,
  MetricsServerInstallRequest,
  MetricsServerInstallResult,
  MetricsServerStatus,
  MetricsServerUninstallResult,
  MetricsSnapshot,
  NamespaceOverview,
  OperatorRollup,
  OverviewCertificates,
  PodResourcesResponse,
  ClusterNetworkSummary,
  NetworkAgentInstallResult,
  NetworkAgentStatus,
  NetworkAgentUninstallResult,
  LocalPortCheckResponse,
  PortForwardInfo,
  PortForwardPreflightResponse,
  PortForwardRequest,
  ResourceKindInfo,
  WatchStatusState,
  ListResponse,
  RelationshipGraph,
  PodEnvResponse,
  ResourceDryRunResponse,
  SecretTlsResponse,
  ScaleRequest,
  SearchResult,
  RolloutRestartRequest,
  CordonRequest,
  DrainRequest,
  DrainStartedResponse,
  SetImageRequest,
  SuspendCronJobRequest,
  RerunJobRequest,
  RolloutUndoRequest,
  RolloutPauseRequest,
  RolloutRevision,
  DebugPodRequest,
  DebugPodResponse,
  StopDebugRequest,
  HelmRepo,
  HelmChartSummary,
  HelmChartVersion,
  HelmChartDetail,
  HelmChartHit,
  HelmChartSourceRef,
  HelmChartUpdate,
  HelmUpdateCheck,
  HelmHubChart,
  HelmInstallRequest,
  HelmUpgradeRequest,
  HelmDryRunResult,
  HelmOperation,
  HelmOperationStarted,
  HelmUninstallResult,
  AppInfo,
  PrinterColumn,
  AuditReport,
  KubeconfigSettings,
  SetKubeconfigRequest,
  KubeconfigImportRequest,
  KubeconfigImportResponse,
  EditClusterRequest,
  SetSshHostRequest,
  SshInfoResponse,
  TestConnectionResponse,
} from '@kubus/shared';
import { groupToPath } from '@kubus/shared';
import { apiFetch } from './http.js';
import { LOCAL_ERROR_HANDLING_META } from './mutation-errors.js';
import { watchClient } from './ws/watch-client.js';
import { useClustersStore } from '../state/clusters.js';
import { useRefetchInterval } from '../state/prefs.js';
import { showToast } from '../state/toast.js';

// ---- Contexts ----

/**
 * Mounted once at the app root: re-fetches the context list on server
 * kubeconfig broadcasts and refreshes discovery-derived queries when a
 * cluster's CRD set changes. One shared subscription serves every
 * useContexts() observer, so the hook itself stays subscription-free.
 */
export function useContextsInvalidation() {
  const qc = useQueryClient();
  useEffect(
    () =>
      watchClient.onBroadcast((msg) => {
        if (msg.op === 'contexts-changed') {
          void qc.invalidateQueries({ queryKey: ['contexts'] });
          void qc.invalidateQueries({ queryKey: ['kubeconfig-settings'] });
        }
        // The cluster's CRD set changed (helm install, operator, kubectl …) —
        // refresh everything derived from API discovery so new kinds appear live.
        if (msg.op === 'discovery-update') {
          void qc.invalidateQueries({ queryKey: ['api-resources', msg.ctx] });
          void qc.invalidateQueries({ queryKey: ['api-resources-multi'] });
          void qc.invalidateQueries({ queryKey: ['crd-columns'] });
        }
      }),
    [qc],
  );
}

/**
 * The shared context list. The always-mounted cluster picker is the sole
 * poller; every other observer passes poll: false and rides on the cache —
 * each polling observer runs its own interval timer, so N observers would
 * otherwise multiply the refetches. Kubeconfig changes reach non-polling
 * observers anyway via the contexts-changed broadcast invalidation.
 */
export function useContexts({ poll = true }: { poll?: boolean } = {}) {
  const interval = useRefetchInterval(30_000);
  return useQuery({
    queryKey: ['contexts'],
    queryFn: () => apiFetch<ContextInfo[]>('/api/contexts'),
    refetchInterval: poll ? interval : false,
  });
}

export function useConnectContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ctx, connect }: { ctx: string; connect: boolean }) =>
      apiFetch<ContextInfo[]>(`/api/contexts/${encodeURIComponent(ctx)}/connect`, { method: connect ? 'POST' : 'DELETE' }),
    onSuccess: (contexts) => {
      qc.setQueryData(['contexts'], contexts);
      void qc.invalidateQueries({ queryKey: ['api-resources'] });
      void qc.invalidateQueries({ queryKey: ['api-resources-multi'] });
      void qc.invalidateQueries({ queryKey: ['namespaces'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useReconnectContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ctx: string) => apiFetch<ContextInfo[]>(`/api/contexts/${encodeURIComponent(ctx)}/reconnect`, { method: 'POST' }),
    onSuccess: (contexts) => {
      qc.setQueryData(['contexts'], contexts);
      void qc.invalidateQueries({ queryKey: ['api-resources'] });
      void qc.invalidateQueries({ queryKey: ['api-resources-multi'] });
      void qc.invalidateQueries({ queryKey: ['crd-columns'] });
      void qc.invalidateQueries({ queryKey: ['namespaces'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (ctx: string) => apiFetch<TestConnectionResponse>(`/api/contexts/${encodeURIComponent(ctx)}/test`, { method: 'POST' }),
  });
}

export function useClusterCa(ctx: string, enabled: boolean) {
  return useQuery({
    queryKey: ['cluster-ca', ctx],
    queryFn: () => apiFetch<{ pem: string | null }>(`/api/contexts/${encodeURIComponent(ctx)}/ca`),
    enabled,
    staleTime: Infinity,
  });
}

export function useEditCluster() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, body }: { ctx: string; body: EditClusterRequest }) =>
      apiFetch<ContextInfo[]>(`/api/contexts/${encodeURIComponent(ctx)}/cluster`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (contexts) => {
      qc.setQueryData(['contexts'], contexts);
      void qc.invalidateQueries({ queryKey: ['kubeconfig-settings'] });
    },
  });
}

/** Remove a context (and its unshared cluster/user entries) from the kubeconfig. */
export function useDeleteCluster() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: (ctx: string) => apiFetch<ContextInfo[]>(`/api/contexts/${encodeURIComponent(ctx)}`, { method: 'DELETE' }),
    onSuccess: (contexts, ctx) => {
      useClustersStore.getState().removeContext(ctx);
      qc.setQueryData(['contexts'], contexts);
      void qc.invalidateQueries({ queryKey: ['kubeconfig-settings'] });
    },
  });
}

/** Set/clear the Kubus-managed SSH jump host for a context (used by the Add-cluster flow). */
export function useSetSshHost() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, body }: { ctx: string; body: SetSshHostRequest }) =>
      apiFetch<ContextInfo[]>(`/api/contexts/${encodeURIComponent(ctx)}/ssh-host`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (contexts) => qc.setQueryData(['contexts'], contexts),
  });
}

/** SSH client availability + jump hosts parsed from ~/.ssh/config (for the cluster editor). */
export function useSshInfo(enabled = true) {
  return useQuery({
    queryKey: ['ssh-info'],
    queryFn: () => apiFetch<SshInfoResponse>('/api/ssh/info'),
    enabled,
    staleTime: 30_000,
  });
}

// ---- Settings / kubeconfig management ----

export function useKubeconfigSettings(enabled = true) {
  return useQuery({
    queryKey: ['kubeconfig-settings'],
    queryFn: () => apiFetch<KubeconfigSettings>('/api/settings/kubeconfig'),
    enabled,
  });
}

export function useSetKubeconfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: (body: SetKubeconfigRequest) =>
      apiFetch<KubeconfigSettings>('/api/settings/kubeconfig', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (settings) => {
      qc.setQueryData(['kubeconfig-settings'], settings);
      void qc.invalidateQueries({ queryKey: ['contexts'] });
    },
  });
}

export function useImportKubeconfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: (body: KubeconfigImportRequest) =>
      apiFetch<KubeconfigImportResponse>('/api/settings/kubeconfig/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (resp) => {
      qc.setQueryData(['contexts'], resp.contexts);
      void qc.invalidateQueries({ queryKey: ['kubeconfig-settings'] });
    },
  });
}

export function useApiResources(ctx: string | undefined) {
  return useQuery({
    queryKey: ['api-resources', ctx],
    queryFn: () => apiFetch<ResourceKindInfo[]>(`/api/contexts/${encodeURIComponent(ctx!)}/api-resources`),
    enabled: !!ctx,
    staleTime: 5 * 60 * 1000,
  });
}

export interface ApiResourcesForContexts {
  resources: ResourceKindInfo[];
  byContext: Record<string, ResourceKindInfo[]>;
  errors: Record<string, string>;
}

function mergeResourceKinds(lists: ResourceKindInfo[][]): ResourceKindInfo[] {
  const byKey = new Map<string, ResourceKindInfo>();
  for (const kind of lists.flat()) {
    const key = `${kind.group}/${kind.version}/${kind.plural}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...kind, verbs: [...kind.verbs] });
      continue;
    }
    byKey.set(key, {
      ...prev,
      kind: prev.kind || kind.kind,
      namespaced: prev.namespaced || kind.namespaced,
      verbs: [...new Set([...prev.verbs, ...kind.verbs])],
      shortNames: [...new Set([...(prev.shortNames ?? []), ...(kind.shortNames ?? [])])],
      categories: [...new Set([...(prev.categories ?? []), ...(kind.categories ?? [])])],
      custom: prev.custom || kind.custom,
    });
  }
  return [...byKey.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.group.localeCompare(b.group) || a.plural.localeCompare(b.plural));
}

export function useApiResourcesForContexts(contexts: string[]) {
  return useQuery({
    queryKey: ['api-resources-multi', contexts],
    queryFn: async (): Promise<ApiResourcesForContexts> => {
      const entries = await Promise.all(
        contexts.map(async (ctx) => {
          try {
            const resources = await apiFetch<ResourceKindInfo[]>(`/api/contexts/${encodeURIComponent(ctx)}/api-resources`);
            return [ctx, resources, undefined] as const;
          } catch (err) {
            return [ctx, [] as ResourceKindInfo[], err instanceof Error ? err.message : String(err)] as const;
          }
        }),
      );
      const byContext = Object.fromEntries(entries.map(([ctx, resources]) => [ctx, resources]));
      const errors = Object.fromEntries(entries.filter(([, , err]) => !!err).map(([ctx, , err]) => [ctx, err!]));
      return { resources: mergeResourceKinds(entries.map(([, resources]) => resources)), byContext, errors };
    },
    enabled: contexts.length > 0,
    staleTime: 5 * 60 * 1000,
  });
}

export function useNamespaces(contexts: string[]) {
  return useQuery({
    queryKey: ['namespaces', contexts],
    queryFn: async () => {
      const all = await Promise.all(
        contexts.map((ctx) => apiFetch<string[]>(`/api/contexts/${encodeURIComponent(ctx)}/namespaces`).catch(() => [] as string[])),
      );
      return [...new Set(all.flat())].sort();
    },
    enabled: contexts.length > 0,
    refetchInterval: useRefetchInterval(60_000),
  });
}

// ---- Watched resource lists ----

export interface ClusterRow {
  ctx: string;
  obj: KubeObject;
}

export interface WatchedListState {
  rows: ClusterRow[];
  /** Per-context connection status. */
  status: Record<string, { state: WatchStatusState | 'loading'; message?: string }>;
}

export interface ResourceListFilters {
  labelSelector?: string;
}

/**
 * Live multi-cluster resource list: one watch subscription per selected
 * context, merged into a single row set keyed by uid.
 */
export function useWatchedList(contexts: string[], group: string, version: string, plural: string): WatchedListState {
  const [state, setState] = useState<WatchedListState>({ rows: [], status: {} });
  // Per-ctx object maps live in a ref; state is derived on each change.
  const mapsRef = useRef(new Map<string, Map<string, KubeObject>>());
  // Hidden panes keep their subscriptions (the maps stay current) but defer
  // the React commit: at scale every 100 ms watch flush would otherwise
  // re-render a full DataGrid per hidden pane. On reveal the pending rebuild
  // runs once, so revealed tabs are fresh within one commit.
  const paneActive = usePaneActive();
  const paneActiveRef = useRef(paneActive);
  paneActiveRef.current = paneActive;
  const pendingRef = useRef(false);

  const key = `${contexts.join(',')}|${group}/${version}/${plural}`;

  const rebuild = useCallback(() => {
    const rows: ClusterRow[] = [];
    for (const [ctx, objects] of mapsRef.current) {
      for (const obj of objects.values()) rows.push({ ctx, obj });
    }
    setState((prev) => {
      if (prev.rows.length === rows.length && prev.rows.every((r, i) => r.obj === rows[i]!.obj && r.ctx === rows[i]!.ctx)) return prev;
      return { rows, status: prev.status };
    });
  }, []);

  const commit = useCallback(() => {
    if (!paneActiveRef.current) {
      pendingRef.current = true;
      return;
    }
    rebuild();
  }, [rebuild]);

  useEffect(() => {
    if (paneActive && pendingRef.current) {
      pendingRef.current = false;
      rebuild();
    }
  }, [paneActive, rebuild]);

  useEffect(() => {
    const maps = mapsRef.current;
    maps.clear();
    // Keep previous rows and per-ctx status objects: on resubscribe the watch
    // client usually replays a cached snapshot synchronously (same commit),
    // and every setter below bails out on identical content, so a kept-alive
    // tab pane being revealed causes zero state churn (and no grid re-render).
    // When there is no cache, stale rows beat a blank grid until the fresh
    // snapshot lands.
    setState((prev) => ({
      rows: prev.rows,
      status: Object.fromEntries(contexts.map((c) => [c, prev.status[c] ?? { state: 'loading' as const }])),
    }));

    const unsubs = contexts.map((ctx) => {
      const objects = new Map<string, KubeObject>();
      maps.set(ctx, objects);
      return watchClient.subscribe(
        { ctx, group: groupToPath(group), version, plural },
        {
          onSnapshot: (items) => {
            objects.clear();
            for (const item of items) objects.set(item.metadata.uid, item);
            commit();
          },
          onEvents: (events) => {
            for (const ev of events) {
              if (ev.type === 'DELETED') objects.delete(ev.object.metadata.uid);
              else objects.set(ev.object.metadata.uid, ev.object);
            }
            commit();
          },
          onStatus: (s, message) => {
            setState((prev) => {
              const cur = prev.status[ctx];
              if (cur && cur.state === s && cur.message === message) return prev;
              return { rows: prev.rows, status: { ...prev.status, [ctx]: { state: s, message } } };
            });
          },
        },
      );
    });
    return () => {
      for (const unsub of unsubs) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, commit]);

  return state;
}

/** Convenience: watched list filtered to the selected namespaces, or server-filtered when selectors are set. */
export function useFilteredList(group: string, version: string, plural: string, namespaced: boolean, filters?: ResourceListFilters): WatchedListState {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const list = useWatchedList(selected, group, version, plural);
  const hasSelectors = !!filters?.labelSelector?.trim();
  const selectorList = useQuery({
    queryKey: ['selector-list', selected, namespaces, group, version, plural, filters],
    queryFn: async () => {
      const batches = await Promise.all(
        selected.map(async (ctx) => {
          const nsTargets = namespaced && namespaces.length ? namespaces : [undefined];
          const perNs = await Promise.all(
            nsTargets.map(async (namespace) => {
              const params = new URLSearchParams();
              if (namespace) params.set('namespace', namespace);
              if (filters?.labelSelector?.trim()) params.set('labelSelector', filters.labelSelector.trim());
              const q = params.toString();
              const response = await apiFetch<ListResponse>(`/api/contexts/${encodeURIComponent(ctx)}/resources/${groupToPath(group)}/${version}/${plural}${q ? `?${q}` : ''}`);
              return response.items.map((obj) => ({ ctx, obj }));
            }),
          );
          return perNs.flat();
        }),
      );
      return batches.flat();
    },
    enabled: selected.length > 0 && hasSelectors,
    retry: false,
  });

  const watchedRows = useMemo(() => {
    if (!namespaced || namespaces.length === 0) return list.rows;
    const set = new Set(namespaces);
    return list.rows.filter((r) => set.has(r.obj.metadata.namespace ?? ''));
  }, [list.rows, namespaces, namespaced]);
  if (hasSelectors) {
    const state = selectorList.isLoading ? 'loading' : selectorList.error ? 'error' : 'live';
    return {
      rows: selectorList.data ?? [],
      status: Object.fromEntries(selected.map((ctx) => [ctx, { state, message: selectorList.error instanceof Error ? selectorList.error.message : undefined }])),
    };
  }
  return { rows: watchedRows, status: list.status };
}

// ---- Single resource ----

export function resourceUrl(ctx: string, group: string, version: string, plural: string, name: string, namespace?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (namespace) params.set('namespace', namespace);
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  const q = params.toString();
  return `/api/contexts/${encodeURIComponent(ctx)}/resources/${groupToPath(group)}/${version}/${plural}/${encodeURIComponent(name)}${q ? `?${q}` : ''}`;
}

export function useResource(
  sel: { ctx: string; group: string; version: string; plural: string; name: string; namespace?: string; reveal?: boolean } | undefined,
  opts?: { liveMs?: number },
) {
  const interval = useRefetchInterval(opts?.liveMs ?? 0);
  return useQuery({
    queryKey: ['resource', sel],
    queryFn: () => apiFetch<KubeObject>(resourceUrl(sel!.ctx, sel!.group, sel!.version, sel!.plural, sel!.name, sel!.namespace, sel!.reveal ? { reveal: 'true' } : undefined)),
    enabled: !!sel,
    refetchInterval: opts?.liveMs ? interval : false,
  });
}

/** JSON Schema for a kind, derived from the cluster's OpenAPI (covers CRDs). Best-effort: consumers degrade gracefully without it. */
export function useResourceSchema(sel: { ctx: string; group: string; version: string; kind: string } | undefined) {
  return useQuery({
    queryKey: ['resource-schema', sel],
    queryFn: () => {
      const params = new URLSearchParams({ group: sel!.group, version: sel!.version, kind: sel!.kind });
      return apiFetch<Record<string, unknown>>(`/api/contexts/${encodeURIComponent(sel!.ctx)}/schema?${params}`);
    },
    enabled: !!sel,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** One-shot (non-watched) list of a resource kind, with optional selectors. */
export function useResourceList(sel: { ctx: string; group: string; version: string; plural: string; namespace?: string; labelSelector?: string; fieldSelector?: string } | undefined) {
  return useQuery({
    queryKey: ['resource-list', sel],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sel!.namespace) params.set('namespace', sel!.namespace);
      if (sel!.labelSelector) params.set('labelSelector', sel!.labelSelector);
      if (sel!.fieldSelector) params.set('fieldSelector', sel!.fieldSelector);
      const q = params.toString();
      const url = `/api/contexts/${encodeURIComponent(sel!.ctx)}/resources/${groupToPath(sel!.group)}/${sel!.version}/${sel!.plural}${q ? `?${q}` : ''}`;
      return apiFetch<ListResponse>(url);
    },
    enabled: !!sel,
    retry: false,
  });
}

export function useResourceEvents(sel: { ctx: string; name: string; kind?: string; namespace?: string } | undefined) {
  return useQuery({
    queryKey: ['events', sel],
    queryFn: async () => {
      const params = new URLSearchParams({ involvedName: sel!.name });
      if (sel!.kind) params.set('involvedKind', sel!.kind);
      if (sel!.namespace) params.set('namespace', sel!.namespace);
      return apiFetch<{ items: KubeObject[] }>(`/api/contexts/${encodeURIComponent(sel!.ctx)}/events?${params}`);
    },
    enabled: !!sel,
    refetchInterval: useRefetchInterval(15_000),
  });
}

// ---- Detail views ----

export function usePodEnv(sel: { ctx: string; namespace: string; name: string; reveal?: boolean } | undefined) {
  return useQuery({
    queryKey: ['pod-env', sel],
    queryFn: () => {
      const params = new URLSearchParams({ namespace: sel!.namespace, name: sel!.name });
      if (sel!.reveal) params.set('reveal', 'true');
      return apiFetch<PodEnvResponse>(`/api/contexts/${encodeURIComponent(sel!.ctx)}/detail/pod-env?${params}`);
    },
    enabled: !!sel,
    retry: false,
  });
}

export function useSecretTls(sel: { ctx: string; namespace: string; name: string } | undefined) {
  return useQuery({
    queryKey: ['secret-tls', sel],
    queryFn: () => {
      const params = new URLSearchParams({ namespace: sel!.namespace, name: sel!.name });
      return apiFetch<SecretTlsResponse>(`/api/contexts/${encodeURIComponent(sel!.ctx)}/detail/secret-tls?${params}`);
    },
    enabled: !!sel,
    retry: false,
  });
}

export async function resolveLogTargetPods(sel: {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: LogTargetKind;
  namespace: string;
  name: string;
}): Promise<LogTargetPodsResponse> {
  const params = new URLSearchParams({
    group: sel.group,
    version: sel.version,
    plural: sel.plural,
    kind: sel.kind,
    namespace: sel.namespace,
    name: sel.name,
  });
  return apiFetch<LogTargetPodsResponse>(`/api/contexts/${encodeURIComponent(sel.ctx)}/detail/log-target-pods?${params}`);
}

// ---- Mutations ----

export function useApplyResource() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, group, version, plural, name, namespace, yamlBody }: { ctx: string; group: string; version: string; plural: string; name: string; namespace?: string; yamlBody: string }) =>
      apiFetch<KubeObject>(resourceUrl(ctx, group, version, plural, name, namespace), {
        method: 'PUT',
        headers: { 'content-type': 'application/yaml' },
        body: yamlBody,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['resource'] }),
  });
}

export function useCreateResource() {
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, yamlBody }: { ctx: string; yamlBody: string }) =>
      apiFetch<KubeObject>(`/api/contexts/${encodeURIComponent(ctx)}/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/yaml' },
        body: yamlBody,
      }),
  });
}

export function useDryRunResource() {
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, yamlBody }: { ctx: string; yamlBody: string }) =>
      apiFetch<ResourceDryRunResponse>(`/api/contexts/${encodeURIComponent(ctx)}/resources/dry-run`, {
        method: 'POST',
        headers: { 'content-type': 'application/yaml' },
        body: yamlBody,
      }),
  });
}

export function useDeleteResource() {
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, group, version, plural, name, namespace }: { ctx: string; group: string; version: string; plural: string; name: string; namespace?: string }) =>
      apiFetch(resourceUrl(ctx, group, version, plural, name, namespace), { method: 'DELETE' }),
  });
}

function actionMutation<T, R = { ok: boolean }>(action: string) {
  return ({ ctx, body }: { ctx: string; body: T }) =>
    apiFetch<R>(`/api/contexts/${encodeURIComponent(ctx)}/actions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

export function useScale() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<ScaleRequest>('scale') });
}
export function useRolloutRestart() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<RolloutRestartRequest>('rollout-restart') });
}
export function useCordon() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<CordonRequest>('cordon') });
}
export function useDrain() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<DrainRequest, DrainStartedResponse>('drain') });
}
export function useSuspendCronJob() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<SuspendCronJobRequest>('suspend-cronjob') });
}
export function useSetImage() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<SetImageRequest>('set-image') });
}
export function useRerunJob() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<RerunJobRequest, { jobName: string }>('rerun-job') });
}
export function useRolloutUndo() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<RolloutUndoRequest>('rollout-undo') });
}
export function useRolloutPause() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<RolloutPauseRequest>('rollout-pause') });
}
export function useDebugPod() {
  return useMutation({ meta: LOCAL_ERROR_HANDLING_META, mutationFn: actionMutation<DebugPodRequest, DebugPodResponse>('debug-pod') });
}
export function useStopDebug() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: actionMutation<StopDebugRequest>('stop-debug'),
    // The idle loop notices the stop file within ~1s — refetch after that so
    // the pod object actually shows the container as terminated.
    onSuccess: () => {
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['resource'] }), 1500);
    },
  });
}

export function useRolloutHistory(sel: { ctx: string; kind: string; namespace?: string; name: string } | undefined) {
  return useQuery({
    queryKey: ['rollout-history', sel],
    queryFn: () => {
      const params = new URLSearchParams({ kind: sel!.kind, namespace: sel!.namespace ?? '', name: sel!.name });
      return apiFetch<RolloutRevision[]>(`/api/contexts/${encodeURIComponent(sel!.ctx)}/detail/rollout-history?${params}`);
    },
    enabled: !!sel && (sel.kind === 'Deployment' || sel.kind === 'StatefulSet' || sel.kind === 'DaemonSet'),
    refetchInterval: useRefetchInterval(15_000),
  });
}

/** CRD additionalPrinterColumns for a custom resource kind (cached server-side too). */
export function useCrdColumns(ctx: string | undefined, group: string, version: string, plural: string, enabled: boolean) {
  return useQuery({
    queryKey: ['crd-columns', ctx, group, version, plural],
    queryFn: () =>
      apiFetch<PrinterColumn[]>(`/api/contexts/${encodeURIComponent(ctx!)}/printer-columns/${groupToPath(group)}/${version}/${plural}`),
    enabled: enabled && !!ctx,
    staleTime: 5 * 60_000,
  });
}

// ---- Metrics / overview ----

export function useNodeMetrics(ctx: string) {
  return useQuery({
    queryKey: ['metrics-nodes', ctx],
    queryFn: () => apiFetch<MetricsSnapshot>(`/api/contexts/${encodeURIComponent(ctx)}/metrics/nodes`),
    refetchInterval: useRefetchInterval(20_000),
  });
}

/**
 * Per-context usage snapshots for the Pod or Node list views. One cache entry
 * per context (not per context list), so a single-cluster detail view shares
 * the multi-cluster list page's snapshot instead of starting a second poll
 * loop for the same data.
 *
 * The observer memoizes the combined result on the `combine` identity and the
 * raw results, so both are kept stable here (callers pass fresh context
 * arrays every render): an inline combine would rebuild the Map — new `data`
 * identity — on every render, cascading into rebuilt metric grid columns on
 * each watch flush.
 */
export function useResourceMetrics(contexts: string[], kind: 'pods' | 'nodes') {
  const interval = useRefetchInterval(20_000);
  const contextsKey = contexts.join('\n');
  const queries = useMemo(
    () =>
      (contextsKey ? contextsKey.split('\n') : []).map((ctx) => ({
        queryKey: ['metrics-snapshot', kind, ctx] as const,
        queryFn: () =>
          apiFetch<MetricsSnapshot>(`/api/contexts/${encodeURIComponent(ctx)}/metrics/${kind}`).catch(
            () => ({ available: false, probed: true, items: [] }) as MetricsSnapshot,
          ),
        refetchInterval: interval,
      })),
    [contextsKey, kind, interval],
  );
  const combine = useCallback(
    (results: Array<{ data?: MetricsSnapshot }>) => {
      const ctxs = contextsKey ? contextsKey.split('\n') : [];
      if (!ctxs.length) return { data: undefined as Map<string, MetricsSnapshot> | undefined };
      const data = new Map<string, MetricsSnapshot>();
      results.forEach((result, i) => {
        if (result.data) data.set(ctxs[i]!, result.data);
      });
      return { data };
    },
    [contextsKey],
  );
  return useQueries({ queries, combine });
}

export function useMetricsHistory(sel: { ctx: string; kind: 'pod' | 'node'; name: string; namespace?: string } | undefined) {
  return useQuery({
    queryKey: ['metrics-history', sel],
    queryFn: () => {
      const params = new URLSearchParams({ kind: sel!.kind, name: sel!.name });
      if (sel!.namespace) params.set('namespace', sel!.namespace);
      return apiFetch<MetricsHistoryResponse>(`/api/contexts/${encodeURIComponent(sel!.ctx)}/metrics/history?${params}`);
    },
    enabled: !!sel,
    refetchInterval: useRefetchInterval(20_000),
  });
}

export function useMetricsSummary(ctx: string) {
  return useQuery({
    queryKey: ['metrics-summary', ctx],
    queryFn: () => apiFetch<ClusterMetricsSummary>(`/api/contexts/${encodeURIComponent(ctx)}/metrics/summary`),
    refetchInterval: useRefetchInterval(20_000),
    placeholderData: keepPreviousData,
  });
}

// ---- metrics-server install / uninstall ----

export function useMetricsServerStatus(ctx: string) {
  const interval = useRefetchInterval(30_000);
  return useQuery({
    queryKey: ['metrics-server-status', ctx],
    queryFn: () => apiFetch<MetricsServerStatus>(`/api/contexts/${encodeURIComponent(ctx)}/metrics-server`),
    // Install status is near-static; poll fast only while an install is
    // settling (manifests applied → Deployment ready → metrics flowing).
    refetchInterval: (query) => {
      if (interval === false) return false;
      const s = query.state.data;
      return s?.installed && (!s.ready || !s.metricsAvailable) ? Math.min(interval, 5_000) : interval;
    },
    retry: false,
  });
}

/**
 * One-shot refetch of metrics queries — also the "refresh now" action, so it
 * works while polling is paused. Scoped to one cluster when ctx is given so a
 * per-cluster refresh doesn't fan out to every selected cluster.
 */
export function invalidateMetricsServer(qc: ReturnType<typeof useQueryClient>, ctx?: string): void {
  void qc.invalidateQueries({ queryKey: ctx ? ['metrics-server-status', ctx] : ['metrics-server-status'] });
  void qc.invalidateQueries({ queryKey: ctx ? ['metrics-summary', ctx] : ['metrics-summary'] });
  void qc.invalidateQueries({ queryKey: ctx ? ['metrics-nodes', ctx] : ['metrics-nodes'] });
  // ctx sits deeper in these keys: snapshots key ['metrics-snapshot', kind, ctx], history keys a selector object.
  void qc.invalidateQueries({
    queryKey: ['metrics-snapshot'],
    predicate: (q) => !ctx || q.queryKey[2] === ctx,
  });
  void qc.invalidateQueries({
    queryKey: ['metrics-history'],
    predicate: (q) => !ctx || (q.queryKey[1] as { ctx?: string } | undefined)?.ctx === ctx,
  });
}

export function useInstallMetricsServer() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, body }: { ctx: string; body: MetricsServerInstallRequest }) =>
      apiFetch<MetricsServerInstallResult>(`/api/contexts/${encodeURIComponent(ctx)}/metrics-server/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_result, { ctx }) => invalidateMetricsServer(qc, ctx),
  });
}

export function useUninstallMetricsServer() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx }: { ctx: string }) =>
      apiFetch<MetricsServerUninstallResult>(`/api/contexts/${encodeURIComponent(ctx)}/metrics-server`, { method: 'DELETE' }),
    onSuccess: (_result, { ctx }) => invalidateMetricsServer(qc, ctx),
  });
}

// ---- network metrics / network-agent install / uninstall ----

export function useNetworkSummary(ctx: string) {
  return useQuery({
    queryKey: ['network-summary', ctx],
    queryFn: () => apiFetch<ClusterNetworkSummary>(`/api/contexts/${encodeURIComponent(ctx)}/network-metrics/summary`),
    refetchInterval: useRefetchInterval(20_000),
    placeholderData: keepPreviousData,
  });
}

export function useNetworkAgentStatus(ctx: string) {
  const interval = useRefetchInterval(30_000);
  return useQuery({
    queryKey: ['network-agent-status', ctx],
    queryFn: () => apiFetch<NetworkAgentStatus>(`/api/contexts/${encodeURIComponent(ctx)}/network-agent`),
    // Same idea as useMetricsServerStatus: fast cadence only while the
    // DaemonSet rollout or first traffic samples are still settling.
    refetchInterval: (query) => {
      if (interval === false) return false;
      const s = query.state.data;
      const settling = !!s?.installed && (!s.ready || !s.metricsAvailable || s.nodesReady < s.nodesDesired);
      return settling ? Math.min(interval, 5_000) : interval;
    },
    retry: false,
  });
}

function invalidateNetworkAgent(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['network-agent-status'] });
  void qc.invalidateQueries({ queryKey: ['network-summary'] });
}

export function useInstallNetworkAgent() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx }: { ctx: string }) =>
      apiFetch<NetworkAgentInstallResult>(`/api/contexts/${encodeURIComponent(ctx)}/network-agent/install`, { method: 'POST' }),
    onSuccess: () => invalidateNetworkAgent(qc),
  });
}

export function useUninstallNetworkAgent() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx }: { ctx: string }) =>
      apiFetch<NetworkAgentUninstallResult>(`/api/contexts/${encodeURIComponent(ctx)}/network-agent`, { method: 'DELETE' }),
    onSuccess: () => invalidateNetworkAgent(qc),
  });
}

export function useOverview(ctx: string) {
  return useQuery({
    queryKey: ['overview', ctx],
    queryFn: () => apiFetch<ClusterOverview>(`/api/contexts/${encodeURIComponent(ctx)}/overview`),
    refetchInterval: useRefetchInterval(10_000),
  });
}

/** Overview sections that warm up slowly stream in behind the core payload. */
function overviewSectionQuery(ctx: string, section: 'operators' | 'certificates', namespaces?: string[]) {
  const key = namespaces && namespaces.length > 0 ? [...namespaces].sort().join(',') : '';
  return {
    queryKey: [`overview-${section}`, ctx, key],
    path: `/api/contexts/${encodeURIComponent(ctx)}/overview/${section}${key ? `?namespaces=${encodeURIComponent(key)}` : ''}`,
  };
}

/**
 * Operator rollups (cert-manager, Argo, Flux…), optionally namespace-scoped.
 * No placeholder across key changes: a namespace switch must not show the
 * previous scope's rollups while the new scope loads.
 */
export function useOverviewOperators(ctx: string, namespaces?: string[]) {
  const { queryKey, path } = overviewSectionQuery(ctx, 'operators', namespaces);
  return useQuery({
    queryKey,
    queryFn: () => apiFetch<OperatorRollup[]>(path),
    refetchInterval: useRefetchInterval(15_000),
  });
}

/** TLS certificate expiry rollup, optionally namespace-scoped. Same no-placeholder rule as operators. */
export function useOverviewCertificates(ctx: string, namespaces?: string[]) {
  const { queryKey, path } = overviewSectionQuery(ctx, 'certificates', namespaces);
  return useQuery({
    queryKey,
    queryFn: () => apiFetch<OverviewCertificates>(path),
    refetchInterval: useRefetchInterval(30_000),
  });
}

/** Live pod usage joined with requests/limits — thresholds are applied client-side. */
export function usePodResources(ctx: string, namespace?: string) {
  return useQuery({
    queryKey: ['pod-resources', ctx, namespace ?? ''],
    queryFn: () => {
      const q = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
      return apiFetch<PodResourcesResponse>(`/api/contexts/${encodeURIComponent(ctx)}/overview/pod-resources${q}`);
    },
    refetchInterval: useRefetchInterval(20_000),
    placeholderData: keepPreviousData,
  });
}

/** Namespace-scoped overview for the global namespace selection. */
export function useNamespaceOverview(ctx: string, namespaces: string[]) {
  const key = [...namespaces].sort().join(',');
  return useQuery({
    queryKey: ['namespace-overview', ctx, key],
    queryFn: () => apiFetch<NamespaceOverview>(`/api/contexts/${encodeURIComponent(ctx)}/namespace-overview?namespaces=${encodeURIComponent(key)}`),
    enabled: !!ctx && namespaces.length > 0,
    refetchInterval: useRefetchInterval(10_000),
    placeholderData: keepPreviousData,
  });
}

export interface ClusterAuditResult {
  ctx: string;
  report?: AuditReport;
  error?: string;
}

/** Security audit per selected cluster — a failed cluster becomes an error entry, not a failed query. */
export function useAudit(contexts: string[]) {
  return useQuery({
    queryKey: ['audit', contexts],
    queryFn: async (): Promise<ClusterAuditResult[]> =>
      Promise.all(
        contexts.map(async (ctx) => {
          try {
            return { ctx, report: await apiFetch<AuditReport>(`/api/contexts/${encodeURIComponent(ctx)}/audit`) };
          } catch (err) {
            return { ctx, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      ),
    enabled: contexts.length > 0,
    staleTime: 60_000,
  });
}

// ---- Search / topology ----

export function useGlobalSearch(contexts: string[], query: string) {
  return useQuery({
    queryKey: ['global-search', contexts, query],
    queryFn: async () => {
      const q = query.trim();
      const batches = await Promise.all(
        contexts.map((ctx) =>
          apiFetch<SearchResult[]>(`/api/contexts/${encodeURIComponent(ctx)}/search?q=${encodeURIComponent(q)}&limit=30`).catch(() => [] as SearchResult[]),
        ),
      );
      return batches.flat().sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, 80);
    },
    enabled: contexts.length > 0 && query.trim().length > 1,
    staleTime: 10_000,
  });
}

export interface TopologyFocus {
  group: string;
  version: string;
  plural: string;
  kind: string;
  name: string;
  namespace?: string;
  depth?: number;
}

/**
 * Shared between useTopologyGraphs and the prefetch in TopologyGraph, which
 * starts this fetch while the heavy graph chunk is still downloading.
 */
export function topologyGraphsOptions(contexts: string[], namespaces: string[], focus?: TopologyFocus) {
  return queryOptions({
    queryKey: ['topology-graphs', contexts, namespaces, focus],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (namespaces.length) params.set('namespace', namespaces.join(','));
      if (focus) {
        params.set('focusGroup', focus.group);
        params.set('focusVersion', focus.version);
        params.set('focusPlural', focus.plural);
        params.set('focusKind', focus.kind);
        params.set('focusName', focus.name);
        params.set('focusNamespace', focus.namespace ?? '');
        params.set('depth', String(focus.depth ?? 2));
      }
      const q = params.toString();
      const graphs = await Promise.all(
        contexts.map((ctx) => apiFetch<RelationshipGraph>(`/api/contexts/${encodeURIComponent(ctx)}/graph${q ? `?${q}` : ''}`).catch((err) => ({ ctx, nodes: [], edges: [], warnings: [err instanceof Error ? err.message : String(err)] }) as RelationshipGraph)),
      );
      return graphs;
    },
    staleTime: 15_000,
  });
}

export function useTopologyGraphs(contexts: string[], namespaces: string[], focus?: TopologyFocus) {
  return useQuery({
    ...topologyGraphsOptions(contexts, namespaces, focus),
    enabled: contexts.length > 0,
    refetchInterval: useRefetchInterval(20_000),
    placeholderData: keepPreviousData,
  });
}

// ---- Helm ----

export function useHelmReleases(contexts: string[]) {
  return useQuery({
    queryKey: ['helm-releases', contexts],
    queryFn: async () => {
      const all = await Promise.all(
        contexts.map(async (ctx) => {
          const releases = await apiFetch<HelmReleaseSummary[]>(`/api/contexts/${encodeURIComponent(ctx)}/helm/releases`).catch(() => [] as HelmReleaseSummary[]);
          return releases.map((r) => ({ ctx, release: r }));
        }),
      );
      return all.flat();
    },
    enabled: contexts.length > 0,
    refetchInterval: useRefetchInterval(30_000),
  });
}

export function useHelmRelease(ctx: string | undefined, ns: string | undefined, name: string | undefined) {
  return useQuery({
    queryKey: ['helm-release', ctx, ns, name],
    queryFn: () => apiFetch<HelmReleaseDetail>(`/api/contexts/${encodeURIComponent(ctx!)}/helm/releases/${encodeURIComponent(ns!)}/${encodeURIComponent(name!)}`),
    enabled: !!ctx && !!ns && !!name,
  });
}

export function useHelmHistory(ctx: string | undefined, ns: string | undefined, name: string | undefined) {
  return useQuery({
    queryKey: ['helm-history', ctx, ns, name],
    queryFn: () => apiFetch<HelmRevision[]>(`/api/contexts/${encodeURIComponent(ctx!)}/helm/releases/${encodeURIComponent(ns!)}/${encodeURIComponent(name!)}/history`),
    enabled: !!ctx && !!ns && !!name,
  });
}

export function useHelmOperations() {
  return useQuery({
    queryKey: ['helm-operations'],
    queryFn: () => apiFetch<HelmOperation[]>('/api/helm/operations'),
    refetchInterval: (query) => (query.state.data?.some((operation) => operation.status === 'running') ? 2_000 : 30_000),
  });
}

/**
 * One app-wide bridge from Helm progress broadcasts into React Query. The
 * HTTP list remains the reconnect/reload source of truth.
 */
export function useHelmOperationEvents(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      watchClient.onBroadcast((message) => {
        if (message.op !== 'helm-operation') return;
        const operation = message.operation;
        let previous: HelmOperation | undefined;
        qc.setQueryData<HelmOperation[]>(['helm-operations'], (current) => {
          previous = current?.find((item) => item.id === operation.id);
          return [operation, ...(current ?? []).filter((item) => item.id !== operation.id)].toSorted((left, right) =>
            right.startedAt.localeCompare(left.startedAt),
          );
        });

        const revisionBecameVisible = !previous?.revision && !!operation.revision;
        const pendingRecordBecameVisible =
          previous?.phase !== operation.phase && !!operation.revision && (operation.phase === 'pre-hook' || operation.phase === 'applying');
        const becameTerminal = previous?.status === 'running' && operation.status !== 'running';
        if (revisionBecameVisible || pendingRecordBecameVisible || becameTerminal) {
          void qc.invalidateQueries({ queryKey: ['helm-releases'] });
          void qc.invalidateQueries({ queryKey: ['helm-release', operation.ctx, operation.namespace, operation.releaseName] });
          void qc.invalidateQueries({ queryKey: ['helm-history', operation.ctx, operation.namespace, operation.releaseName] });
        }
        if (becameTerminal) {
          if (operation.status === 'succeeded') {
            showToast('success', `${operation.kind} completed for ${operation.namespace}/${operation.releaseName}`);
          } else {
            showToast('error', `${operation.kind} failed for ${operation.namespace}/${operation.releaseName} — review the Helm Releases page for recovery guidance`);
          }
        }
      }),
    [qc],
  );
}

export function useHelmRevision(ctx: string | undefined, ns: string | undefined, name: string | undefined, revision: number | undefined) {
  return useQuery({
    queryKey: ['helm-revision', ctx, ns, name, revision],
    queryFn: () =>
      apiFetch<HelmReleaseDetail>(
        `/api/contexts/${encodeURIComponent(ctx!)}/helm/releases/${encodeURIComponent(ns!)}/${encodeURIComponent(name!)}/revisions/${revision}`,
      ),
    enabled: !!ctx && !!ns && !!name && !!revision,
    staleTime: Infinity, // a helm revision is immutable
  });
}

export function useHelmUninstall() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, ns, name, skipHooks, deleteCrds }: { ctx: string; ns: string; name: string; skipHooks?: boolean; deleteCrds?: boolean }) => {
      const q = new URLSearchParams();
      if (skipHooks) q.set('skipHooks', 'true');
      if (deleteCrds) q.set('deleteCrds', 'true');
      const qs = q.size ? `?${q.toString()}` : '';
      return apiFetch<HelmUninstallResult>(
        `/api/contexts/${encodeURIComponent(ctx)}/helm/releases/${encodeURIComponent(ns)}/${encodeURIComponent(name)}${qs}`,
        { method: 'DELETE' },
      );
    },
    onSettled: (_result, _error, { ctx, ns, name }) => {
      void qc.invalidateQueries({ queryKey: ['helm-releases'] });
      void qc.invalidateQueries({ queryKey: ['helm-release', ctx, ns, name] });
      void qc.invalidateQueries({ queryKey: ['helm-history', ctx, ns, name] });
    },
  });
}

export function useHelmRollback() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({
      ctx,
      ns,
      name,
      revision,
      skipHooks,
      wait,
      timeoutSeconds,
    }: {
      ctx: string;
      ns: string;
      name: string;
      revision: number;
      skipHooks?: boolean;
      wait?: boolean;
      timeoutSeconds?: number;
    }) =>
      apiFetch<HelmOperationStarted>(`/api/contexts/${encodeURIComponent(ctx)}/helm/releases/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision, skipHooks, wait, timeoutSeconds }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['helm-operations'] }),
  });
}

export function useAppInfo() {
  return useQuery({
    queryKey: ['app-info'],
    queryFn: () => apiFetch<AppInfo>('/api/app/info'),
    staleTime: Infinity,
  });
}

// ---- Helm repos & charts ----

export function useHelmRepos() {
  return useQuery({
    queryKey: ['helm-repos'],
    queryFn: () => apiFetch<HelmRepo[]>('/api/helm/repos'),
  });
}

// Adding/removing a repo changes which charts and versions are discoverable,
// so refresh the catalog and the cross-repo chart-find (upgrade version list).
function invalidateHelmRepoData(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['helm-repos'] });
  void qc.invalidateQueries({ queryKey: ['helm-repo-charts'] });
  void qc.invalidateQueries({ queryKey: ['helm-chart-find'] });
}

export function useAddHelmRepo() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: (repo: HelmRepo) =>
      apiFetch<HelmRepo>('/api/helm/repos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(repo) }),
    onSuccess: () => invalidateHelmRepoData(qc),
  });
}

export function useRemoveHelmRepo() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: (name: string) => apiFetch(`/api/helm/repos/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateHelmRepoData(qc),
  });
}

export function useHelmRepoCharts(repo: string | undefined) {
  return useQuery({
    queryKey: ['helm-repo-charts', repo],
    queryFn: () => apiFetch<HelmChartSummary[]>(`/api/helm/repos/${encodeURIComponent(repo!)}/charts`),
    enabled: !!repo,
    staleTime: 10 * 60 * 1000,
  });
}

export function useHelmChartVersions(repo: string | undefined, chart: string | undefined) {
  return useQuery({
    queryKey: ['helm-chart-versions', repo, chart],
    queryFn: () => apiFetch<HelmChartVersion[]>(`/api/helm/repos/${encodeURIComponent(repo!)}/charts/${encodeURIComponent(chart!)}/versions`),
    enabled: !!repo && !!chart,
    staleTime: 10 * 60 * 1000,
  });
}

export function useHelmChartDetail(repo: string | undefined, chart: string | undefined, version: string | undefined) {
  return useQuery({
    queryKey: ['helm-chart-detail', repo, chart, version],
    queryFn: () =>
      apiFetch<HelmChartDetail>(
        `/api/helm/repos/${encodeURIComponent(repo!)}/charts/${encodeURIComponent(chart!)}/versions/${encodeURIComponent(version!)}/detail`,
      ),
    enabled: !!repo && !!chart && !!version,
    staleTime: Infinity, // a published chart version is immutable
  });
}

/** Exact-name search across all configured repos (upgrade-source discovery). */
export function useHelmChartFind(chart: string | undefined) {
  return useQuery({
    queryKey: ['helm-chart-find', chart],
    queryFn: () => apiFetch<HelmChartHit[]>(`/api/helm/charts/find?name=${encodeURIComponent(chart!)}`),
    enabled: !!chart,
    staleTime: 10 * 60 * 1000,
  });
}

/** Batched, source-safe update hints for installed releases. */
export function useHelmUpdates(items: HelmUpdateCheck[]) {
  return useQuery({
    queryKey: ['helm-updates', items],
    queryFn: () =>
      apiFetch<HelmChartUpdate[]>('/api/helm/updates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      }),
    enabled: items.length > 0,
    staleTime: 10 * 60 * 1000,
  });
}

/** Free-text chart search on Artifact Hub. */
export function useHelmHubSearch(query: string) {
  return useQuery({
    queryKey: ['helm-hub-search', query],
    queryFn: () => apiFetch<HelmHubChart[]>(`/api/helm/hub/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2,
    staleTime: 10 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

/** All published versions of an Artifact Hub package. */
export function useHelmHubVersions(repoName: string | undefined, chart: string | undefined) {
  return useQuery({
    queryKey: ['helm-hub-versions', repoName, chart],
    queryFn: () => apiFetch<{ repoUrl: string; versions: HelmChartVersion[] }>(`/api/helm/hub/versions?repo=${encodeURIComponent(repoName!)}&chart=${encodeURIComponent(chart!)}`),
    enabled: !!repoName && !!chart,
    staleTime: 10 * 60 * 1000,
  });
}

/** Chart metadata + default values by repository URL (Artifact Hub discoveries). */
export function useHelmChartDetailByUrl(repoUrl: string | undefined, chart: string | undefined, version: string | undefined) {
  return useQuery({
    queryKey: ['helm-chart-detail-url', repoUrl, chart, version],
    queryFn: () =>
      apiFetch<HelmChartDetail>(
        `/api/helm/charts/detail?repoUrl=${encodeURIComponent(repoUrl!)}&chart=${encodeURIComponent(chart!)}&version=${encodeURIComponent(version!)}`,
      ),
    enabled: !!repoUrl && !!chart && !!version,
    staleTime: Infinity, // a published chart version is immutable
  });
}

export function useHelmOciDetail(ref: string | undefined, version: string | undefined) {
  return useQuery({
    queryKey: ['helm-oci-detail', ref, version],
    queryFn: () => apiFetch<HelmChartDetail>(`/api/helm/oci/detail?ref=${encodeURIComponent(ref!)}&version=${encodeURIComponent(version!)}`),
    enabled: !!ref && !!version,
    staleTime: Infinity,
  });
}

/** Chart metadata/defaults from any supported source form. */
export function useHelmChartSourceDetail(source: HelmChartSourceRef | undefined) {
  return useQuery({
    queryKey: ['helm-chart-source-detail', source],
    queryFn: () =>
      apiFetch<HelmChartDetail>('/api/helm/charts/detail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(source),
      }),
    enabled: !!source,
    staleTime: Infinity,
  });
}

export interface HelmUpgradeVars {
  ctx: string;
  ns: string;
  name: string;
  values: Record<string, unknown>;
  chart?: HelmChartSourceRef;
  skipHooks?: boolean;
  wait?: boolean;
  timeoutSeconds?: number;
}

export function useHelmUpgrade() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, ns, name, ...body }: HelmUpgradeVars) =>
      apiFetch<HelmOperationStarted>(`/api/contexts/${encodeURIComponent(ctx)}/helm/releases/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/upgrade`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body satisfies HelmUpgradeRequest),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['helm-operations'] }),
  });
}

/** Server-side render without applying — backs the upgrade preview diff. */
export function useHelmUpgradeDryRun() {
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, ns, name, ...body }: HelmUpgradeVars) =>
      apiFetch<HelmDryRunResult>(`/api/contexts/${encodeURIComponent(ctx)}/helm/releases/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/upgrade`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, dryRun: true } satisfies HelmUpgradeRequest),
      }),
  });
}

export interface HelmInstallVars extends Omit<HelmInstallRequest, 'dryRun'> {
  ctx: string;
}

export function useHelmInstall() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, ...body }: HelmInstallVars) =>
      apiFetch<HelmOperationStarted>(`/api/contexts/${encodeURIComponent(ctx)}/helm/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body satisfies HelmInstallRequest),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['helm-operations'] }),
  });
}

export function useHelmInstallDryRun() {
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, ...body }: HelmInstallVars) =>
      apiFetch<HelmDryRunResult>(`/api/contexts/${encodeURIComponent(ctx)}/helm/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, dryRun: true } satisfies HelmInstallRequest),
      }),
  });
}

// ---- Port forwards ----

export function usePortForwards() {
  const qc = useQueryClient();
  useEffect(
    () =>
      watchClient.onBroadcast((msg) => {
        if (msg.op === 'pf-update') qc.setQueryData(['portforwards'], msg.forwards);
      }),
    [qc],
  );
  return useQuery({
    queryKey: ['portforwards'],
    queryFn: () => apiFetch<PortForwardInfo[]>('/api/portforwards'),
    refetchInterval: useRefetchInterval(30_000),
  });
}

export function useStartPortForward() {
  const qc = useQueryClient();
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, body }: { ctx: string; body: PortForwardRequest }) =>
      apiFetch<PortForwardInfo>(`/api/contexts/${encodeURIComponent(ctx)}/portforwards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portforwards'] }),
  });
}

export function useStopPortForward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/portforwards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portforwards'] }),
  });
}

export function useStopAllPortForwards() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('/api/portforwards', { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portforwards'] }),
  });
}

/** RBAC preflight for pods/portforward create in a namespace. */
export function usePortForwardPreflight(vars: { ctx: string; namespace: string } | undefined) {
  return useQuery({
    queryKey: ['portforward-preflight', vars?.ctx, vars?.namespace],
    queryFn: () =>
      apiFetch<PortForwardPreflightResponse>(
        `/api/contexts/${encodeURIComponent(vars!.ctx)}/portforwards/preflight?namespace=${encodeURIComponent(vars!.namespace)}`,
      ),
    enabled: !!vars,
    staleTime: 60_000,
  });
}

/** Whether a local port can be bound right now (advisory — start() re-checks). */
export function checkLocalPort(port: number): Promise<LocalPortCheckResponse> {
  return apiFetch<LocalPortCheckResponse>(`/api/portforwards/port-check?port=${port}`);
}
