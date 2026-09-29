/** Version 1: portable, JSON-only plugin contract. */
export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  permissions: {
    resources: Array<{ group: string; resources: string[] }>;
    actions: Array<'resource.open' | 'pod.logs' | 'pod.terminal' | 'pod.interfaces' | 'helm.open'>;
  };
}
export interface PluginInfo {
  manifest: PluginManifest;
  bundled: boolean;
  enabled: boolean;
  error?: string;
}
export interface PluginContext {
  contexts: string[];
  namespacesByContext: Record<string, string[]>;
  theme: 'light' | 'dark';
  active: boolean;
  refreshInterval: number | false;
}
export interface PluginResourceRequest {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  namespace?: string;
  name?: string;
  labelSelector?: string;
  continue?: string;
}
export interface PodInterfaceSnapshot {
  podUID: string;
  container: string;
  observedAt: string;
  interfaces: Array<{ name: string; operState: string; adminUp: boolean; carrier: boolean | null; mtu?: number; address?: string }>;
}
export type PluginWatchRequest = Omit<PluginResourceRequest, 'name' | 'continue' | 'labelSelector'>;
export type PluginWatchUpdate<T = unknown> =
  | { kind: 'snapshot'; items: T[] }
  | { kind: 'events'; events: Array<{ type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: T }> }
  | { kind: 'status'; state: 'live' | 'reconnecting' | 'error' | 'unavailable'; message?: string };
export type PluginWatchMessage = { type: 'kubus:watch'; id: string; params: PluginWatchRequest } | { type: 'kubus:unwatch'; id: string };
export type PluginMethod =
  'resources.list' | 'resources.get' | 'resource.open' | 'pod.logs' | 'pod.terminal' | 'pod.interfaces' | 'helm.open';
export interface PluginRequest {
  type: 'kubus:request';
  id: string;
  method: PluginMethod;
  params: PluginResourceRequest & { container?: string };
}
export type PluginHostMessage =
  | { type: 'kubus:context'; context: PluginContext }
  | { type: 'kubus:watch-update'; id: string; update: PluginWatchUpdate }
  | { type: 'kubus:response'; id: string; result?: unknown; error?: { message: string; status?: number } };
