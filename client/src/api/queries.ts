import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  ClusterNetworkSummary,
  NetworkAgentInstallResult,
  NetworkAgentStatus,
  NetworkAgentUninstallResult,
  PortForwardInfo,
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
  TriggerCronJobRequest,
  RerunJobRequest,
  RolloutUndoRequest,
  RolloutPauseRequest,
  RolloutRevision,
  DebugPodRequest,
  DebugPodResponse,
  StopDebugRequest,
  HelmRollbackResult,
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
import { watchClient } from './ws/watch-client.js';
import { useClustersStore } from '../state/clusters.js';
import { useRefetchInterval } from '../state/prefs.js';

// ---- Contexts ----

export function useContexts() {
  const qc = useQueryClient();
  // Re-fetch the context list whenever the server reports kubeconfig changes.
  useEffect(
    () =>
      watchClient.onBroadcast((msg) => {
        if (msg.op === 'contexts-changed') {
          void qc.invalidateQueries({ queryKey: ['contexts'] });
          void qc.invalidateQueries({ queryKey: ['kubeconfig-settings'] });
        }
      }),
    [qc],
  );
  return useQuery({
    queryKey: ['contexts'],
    queryFn: () => apiFetch<ContextInfo[]>('/api/contexts'),
    refetchInterval: useRefetchInterval(30_000),
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

/** Set/clear the Kubus-managed SSH jump host for a context (used by the Add-cluster flow). */
export function useSetSshHost() {
  const qc = useQueryClient();
  return useMutation({
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

export function useResource(sel: { ctx: string; group: string; version: string; plural: string; name: string; namespace?: string; reveal?: boolean } | undefined) {
  return useQuery({
    queryKey: ['resource', sel],
    queryFn: () => apiFetch<KubeObject>(resourceUrl(sel!.ctx, sel!.group, sel!.version, sel!.plural, sel!.name, sel!.namespace, sel!.reveal ? { reveal: 'true' } : undefined)),
    enabled: !!sel,
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
  return useMutation({ mutationFn: actionMutation<ScaleRequest>('scale') });
}
export function useRolloutRestart() {
  return useMutation({ mutationFn: actionMutation<RolloutRestartRequest>('rollout-restart') });
}
export function useCordon() {
  return useMutation({ mutationFn: actionMutation<CordonRequest>('cordon') });
}
export function useDrain() {
  return useMutation({ mutationFn: actionMutation<DrainRequest, DrainStartedResponse>('drain') });
}
export function useTriggerCronJob() {
  return useMutation({ mutationFn: actionMutation<TriggerCronJobRequest, { jobName: string }>('trigger-cronjob') });
}
export function useSuspendCronJob() {
  return useMutation({ mutationFn: actionMutation<SuspendCronJobRequest>('suspend-cronjob') });
}
export function useSetImage() {
  return useMutation({ mutationFn: actionMutation<SetImageRequest>('set-image') });
}
export function useRerunJob() {
  return useMutation({ mutationFn: actionMutation<RerunJobRequest, { jobName: string }>('rerun-job') });
}
export function useRolloutUndo() {
  return useMutation({ mutationFn: actionMutation<RolloutUndoRequest>('rollout-undo') });
}
export function useRolloutPause() {
  return useMutation({ mutationFn: actionMutation<RolloutPauseRequest>('rollout-pause') });
}
export function useDebugPod() {
  return useMutation({ mutationFn: actionMutation<DebugPodRequest, DebugPodResponse>('debug-pod') });
}
export function useStopDebug() {
  const qc = useQueryClient();
  return useMutation({
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
    enabled: !!sel && (sel.kind === 'Deployment' || sel.kind === 'StatefulSet'),
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

/** Per-context usage snapshots for the Pod or Node list views. */
export function useResourceMetrics(contexts: string[], kind: 'pods' | 'nodes') {
  return useQuery({
    queryKey: ['metrics-snapshot', kind, contexts],
    queryFn: async () => {
      const result = new Map<string, MetricsSnapshot>();
      await Promise.all(
        contexts.map(async (ctx) => {
          const snap = await apiFetch<MetricsSnapshot>(`/api/contexts/${encodeURIComponent(ctx)}/metrics/${kind}`).catch(() => ({ available: false, items: [] }) as MetricsSnapshot);
          result.set(ctx, snap);
        }),
      );
      return result;
    },
    enabled: contexts.length > 0,
    refetchInterval: useRefetchInterval(20_000),
  });
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

export function useMetricsServerStatus(ctx: string, opts?: { refetchMs?: number }) {
  return useQuery({
    queryKey: ['metrics-server-status', ctx],
    queryFn: () => apiFetch<MetricsServerStatus>(`/api/contexts/${encodeURIComponent(ctx)}/metrics-server`),
    refetchInterval: useRefetchInterval(opts?.refetchMs ?? 30_000),
    retry: false,
  });
}

function invalidateMetricsServer(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['metrics-server-status'] });
  void qc.invalidateQueries({ queryKey: ['metrics-summary'] });
  void qc.invalidateQueries({ queryKey: ['metrics-nodes'] });
  void qc.invalidateQueries({ queryKey: ['metrics-snapshot'] });
}

export function useInstallMetricsServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ctx, body }: { ctx: string; body: MetricsServerInstallRequest }) =>
      apiFetch<MetricsServerInstallResult>(`/api/contexts/${encodeURIComponent(ctx)}/metrics-server/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateMetricsServer(qc),
  });
}

export function useUninstallMetricsServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ctx }: { ctx: string }) =>
      apiFetch<MetricsServerUninstallResult>(`/api/contexts/${encodeURIComponent(ctx)}/metrics-server`, { method: 'DELETE' }),
    onSuccess: () => invalidateMetricsServer(qc),
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

export function useNetworkAgentStatus(ctx: string, opts?: { refetchMs?: number }) {
  return useQuery({
    queryKey: ['network-agent-status', ctx],
    queryFn: () => apiFetch<NetworkAgentStatus>(`/api/contexts/${encodeURIComponent(ctx)}/network-agent`),
    refetchInterval: useRefetchInterval(opts?.refetchMs ?? 30_000),
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
    mutationFn: ({ ctx }: { ctx: string }) =>
      apiFetch<NetworkAgentInstallResult>(`/api/contexts/${encodeURIComponent(ctx)}/network-agent/install`, { method: 'POST' }),
    onSuccess: () => invalidateNetworkAgent(qc),
  });
}

export function useUninstallNetworkAgent() {
  const qc = useQueryClient();
  return useMutation({
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
    mutationFn: ({ ctx, ns, name }: { ctx: string; ns: string; name: string }) =>
      apiFetch<{ deleted: string[]; failed: Array<{ resource: string; error: string }> }>(`/api/contexts/${encodeURIComponent(ctx)}/helm/releases/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['helm-releases'] }),
  });
}

export function useHelmRollback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ctx, ns, name, revision }: { ctx: string; ns: string; name: string; revision: number }) =>
      apiFetch<HelmRollbackResult>(`/api/contexts/${encodeURIComponent(ctx)}/helm/releases/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision }),
      }),
    onSuccess: (_r, { ctx, ns, name }) => {
      void qc.invalidateQueries({ queryKey: ['helm-releases'] });
      void qc.invalidateQueries({ queryKey: ['helm-release', ctx, ns, name] });
      void qc.invalidateQueries({ queryKey: ['helm-history', ctx, ns, name] });
    },
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
