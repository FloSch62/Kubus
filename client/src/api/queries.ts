import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClusterOverview,
  ContextInfo,
  HelmReleaseDetail,
  HelmReleaseSummary,
  HelmRevision,
  KubeObject,
  MetricsHistoryResponse,
  MetricsSnapshot,
  PortForwardInfo,
  PortForwardRequest,
  ResourceKindInfo,
  ScaleRequest,
  RolloutRestartRequest,
  CordonRequest,
  DrainRequest,
  DrainStartedResponse,
  TriggerCronJobRequest,
} from '@kubedeck/shared';
import { groupToPath } from '@kubedeck/shared';
import { apiFetch } from './http.js';
import { watchClient } from './ws/watch-client.js';
import { useClustersStore } from '../state/clusters.js';

// ---- Contexts ----

export function useContexts() {
  const qc = useQueryClient();
  // Re-fetch the context list whenever the server reports kubeconfig changes.
  useEffect(
    () =>
      watchClient.onBroadcast((msg) => {
        if (msg.op === 'contexts-changed') void qc.invalidateQueries({ queryKey: ['contexts'] });
      }),
    [qc],
  );
  return useQuery({
    queryKey: ['contexts'],
    queryFn: () => apiFetch<ContextInfo[]>('/api/contexts'),
    refetchInterval: 30_000,
  });
}

export function useConnectContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ctx, connect }: { ctx: string; connect: boolean }) =>
      apiFetch<ContextInfo[]>(`/api/contexts/${encodeURIComponent(ctx)}/connect`, { method: connect ? 'POST' : 'DELETE' }),
    onSuccess: (contexts) => qc.setQueryData(['contexts'], contexts),
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
    refetchInterval: 60_000,
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
  status: Record<string, { state: 'live' | 'reconnecting' | 'error' | 'loading'; message?: string }>;
}

/**
 * Live multi-cluster resource list: one watch subscription per selected
 * context, merged into a single row set keyed by uid.
 */
export function useWatchedList(contexts: string[], group: string, version: string, plural: string): WatchedListState {
  const [state, setState] = useState<WatchedListState>({ rows: [], status: {} });
  // Per-ctx object maps live in a ref; state is derived on each change.
  const mapsRef = useRef(new Map<string, Map<string, KubeObject>>());

  const key = useMemo(() => `${contexts.join(',')}|${group}/${version}/${plural}`, [contexts, group, version, plural]);

  useEffect(() => {
    const maps = mapsRef.current;
    maps.clear();
    setState({ rows: [], status: Object.fromEntries(contexts.map((c) => [c, { state: 'loading' as const }])) });

    const rebuild = () => {
      const rows: ClusterRow[] = [];
      for (const [ctx, objects] of maps) {
        for (const obj of objects.values()) rows.push({ ctx, obj });
      }
      setState((prev) => ({ rows, status: prev.status }));
    };

    const unsubs = contexts.map((ctx) => {
      const objects = new Map<string, KubeObject>();
      maps.set(ctx, objects);
      return watchClient.subscribe(
        { ctx, group: groupToPath(group), version, plural },
        {
          onSnapshot: (items) => {
            objects.clear();
            for (const item of items) objects.set(item.metadata.uid, item);
            rebuild();
          },
          onEvents: (events) => {
            for (const ev of events) {
              if (ev.type === 'DELETED') objects.delete(ev.object.metadata.uid);
              else objects.set(ev.object.metadata.uid, ev.object);
            }
            rebuild();
          },
          onStatus: (s, message) => {
            setState((prev) => ({ rows: prev.rows, status: { ...prev.status, [ctx]: { state: s, message } } }));
          },
        },
      );
    });
    return () => {
      for (const unsub of unsubs) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/** Convenience: watched list filtered to the selected namespaces. */
export function useFilteredList(group: string, version: string, plural: string, namespaced: boolean): WatchedListState {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const list = useWatchedList(selected, group, version, plural);
  const rows = useMemo(() => {
    if (!namespaced || namespaces.length === 0) return list.rows;
    const set = new Set(namespaces);
    return list.rows.filter((r) => set.has(r.obj.metadata.namespace ?? ''));
  }, [list.rows, namespaces, namespaced]);
  return { rows, status: list.status };
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
    refetchInterval: 15_000,
  });
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

// ---- Metrics / overview ----

export function useNodeMetrics(ctx: string) {
  return useQuery({
    queryKey: ['metrics-nodes', ctx],
    queryFn: () => apiFetch<MetricsSnapshot>(`/api/contexts/${encodeURIComponent(ctx)}/metrics/nodes`),
    refetchInterval: 20_000,
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
    refetchInterval: 20_000,
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
    refetchInterval: 20_000,
  });
}

export function useOverview(ctx: string) {
  return useQuery({
    queryKey: ['overview', ctx],
    queryFn: () => apiFetch<ClusterOverview>(`/api/contexts/${encodeURIComponent(ctx)}/overview`),
    refetchInterval: 10_000,
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
    refetchInterval: 30_000,
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

export function useHelmUninstall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ctx, ns, name }: { ctx: string; ns: string; name: string }) =>
      apiFetch<{ deleted: string[]; failed: Array<{ resource: string; error: string }> }>(`/api/contexts/${encodeURIComponent(ctx)}/helm/releases/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['helm-releases'] }),
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
    refetchInterval: 30_000,
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
