import { load, dump } from 'js-yaml';
import type { PluginResourceRequest } from '@kubus/plugin-sdk';

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}
export interface Resource {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    generation?: number;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{ uid?: string; name: string; kind: string }>;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown> & { conditions?: Condition[] };
  [key: string]: unknown;
}
export interface Located extends Resource {
  ctx: string;
  plural: string;
  group: string;
}
export const C9S = 'c9s.run';
export const OWNER = `${C9S}/topologyOwner`;
export const NODE = `${C9S}/topologyNode`;
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function string(value: unknown, fallback = '—'): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}
export function key(resource: Located): string {
  return `${resource.ctx}/${resource.metadata.namespace ?? ''}/${resource.plural}/${resource.metadata.name}`;
}
export function ref(resource: Located): PluginResourceRequest & { name: string } {
  return {
    ctx: resource.ctx,
    group: resource.group,
    version: resource.apiVersion?.split('/').at(-1) ?? 'v1alpha1',
    plural: resource.plural,
    namespace: resource.metadata.namespace,
    name: resource.metadata.name,
  };
}
export function belongsTo(resource: Located, topology: Located): boolean {
  if (resource.ctx !== topology.ctx || resource.metadata.namespace !== topology.metadata.namespace) return false;
  // An explicit UID takes precedence over name labels after delete/recreate.
  const owner = resource.metadata.ownerReferences?.find((o) => o.kind === 'Topology');
  if (owner) return owner.uid && topology.metadata.uid ? owner.uid === topology.metadata.uid : owner.name === topology.metadata.name;
  return resource.metadata.labels?.[OWNER] === topology.metadata.name;
}
export function belongsToNode(resource: Located, node: Located): boolean {
  if (resource.ctx !== node.ctx || resource.metadata.namespace !== node.metadata.namespace) return false;
  const owner = resource.metadata.ownerReferences?.find((o) => o.kind === 'Node');
  if (owner) return owner.uid && node.metadata.uid ? owner.uid === node.metadata.uid : owner.name === node.metadata.name;
  return (
    resource.metadata.labels?.[NODE] === node.metadata.name || resource.metadata.labels?.['c9s.run/direct-workload'] === node.metadata.name
  );
}
export function source(topology: Located): string {
  return string(object(topology.spec?.definition).containerlab, '');
}
export function definition(topology: Located): { nodes: Record<string, unknown>; links: unknown[]; error?: string } {
  try {
    const raw = source(topology);
    if (raw.length > 2_000_000) throw new Error('Topology YAML exceeds the 2 MB viewer limit');
    const topo = object(object(load(raw)).topology);
    return { nodes: object(topo.nodes), links: Array.isArray(topo.links) ? topo.links : [] };
  } catch (error) {
    return { nodes: {}, links: [], error: error instanceof Error ? error.message : String(error) };
  }
}
export function phase(resource: Located): string {
  const s = resource.status ?? {};
  if (resource.plural === 'topologies') {
    if (s.observedGeneration !== undefined && Number(s.observedGeneration) < Number(resource.metadata.generation ?? 0))
      return 'Reconciling';
    if (s.topologyState) return string(s.topologyState);
    return s.topologyReady === true ? 'Running' : s.error ? 'Failed' : 'Deploying';
  }
  if (
    resource.plural === 'nodes' &&
    s.conditions?.some(
      (c) =>
        ['NodeProfileResolved', 'PlanApplied', 'Prepared', 'ConnectivityReady', 'ContainersReady'].includes(c.type) &&
        c.observedGeneration !== undefined &&
        c.observedGeneration < (resource.metadata.generation ?? 0),
    )
  )
    return 'Reconciling';
  if (s.readiness) return string(s.readiness);
  if (s.phase) return string(s.phase);
  const accepted = s.conditions?.find((c) => c.type === 'Accepted');
  if (accepted?.observedGeneration !== undefined && accepted.observedGeneration < (resource.metadata.generation ?? 0)) return 'Reconciling';
  if (accepted) return accepted.status === 'True' ? 'Accepted' : accepted.status === 'False' ? 'Rejected' : 'Unknown';
  const ready = s.conditions?.find((c) => c.type === 'Ready' || c.type === 'ContainersReady');
  return ready ? (ready.status === 'True' ? 'Ready' : 'Not ready') : 'Unknown';
}
export function tone(value: string): 'good' | 'bad' | 'pending' | 'neutral' {
  const s = value.toLowerCase();
  if (['running', 'ready', 'accepted', 'true', 'bound', 'succeeded', 'up'].includes(s)) return 'good';
  if (
    [
      'false',
      'degraded',
      'deployfailed',
      'failed',
      'rejected',
      'not ready',
      'notready',
      'error',
      'warning',
      'down',
      'admin down',
      'missing interface',
    ].includes(s)
  )
    return 'bad';
  if (['deploying', 'pending', 'reconciling', 'starting', 'initializing'].includes(s)) return 'pending';
  return 'neutral';
}
export function counts(topology: Located, nodes: Located[], links: Located[]): { nodes: number; ready: number | null; links: number } {
  const parsed = definition(topology);
  const children = nodes.filter((n) => belongsTo(n, topology));
  const nodeCount =
    typeof topology.status?.nodeCount === 'number' ? topology.status.nodeCount : children.length || Object.keys(parsed.nodes).length;
  return {
    nodes: nodeCount,
    ready:
      typeof topology.status?.readyNodeCount === 'number'
        ? topology.status.readyNodeCount
        : children.length
          ? children.filter((n) => tone(phase(n)) === 'good').length
          : topology.status?.topologyReady === true
            ? nodeCount
            : null,
    links:
      typeof topology.status?.linkCount === 'number'
        ? topology.status.linkCount
        : links.filter((l) => belongsTo(l, topology)).length || parsed.links.length,
  };
}
export function yaml(resource: Located): string {
  const { ctx: _ctx, plural: _plural, group: _group, ...raw } = resource;
  return dump(raw, { lineWidth: 100, noRefs: true });
}
export function age(date?: string): string {
  if (!date) return '—';
  const seconds = Math.max(0, (Date.now() - Date.parse(date)) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
