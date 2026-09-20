import type { KubeObject, ListResponse } from '@kubus/shared';
import type { QuestionScope } from './cluster-answer.js';
export type EvidenceReader = <T>(path: string, init?: RequestInit) => Promise<T>;
export const resourcePaths = {
  pods: 'core/v1/pods', nodes: 'core/v1/nodes', services: 'core/v1/services',
  ingresses: 'networking.k8s.io/v1/ingresses', endpointslices: 'discovery.k8s.io/v1/endpointslices',
  configmaps: 'core/v1/configmaps', secrets: 'core/v1/secrets',
} as const;
export type EvidenceResource = keyof typeof resourcePaths;
export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
export const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
export const stamp = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One read budget for the whole answer. Never report an incomplete list as a total. */
export function evidenceReader(scope: QuestionScope, signal: AbortSignal, read: EvidenceReader) {
  let requests = 0, objectsRead = 0;
  const base = `/api/contexts/${encodeURIComponent(scope.context)}`;
  const get = async <T>(path: string): Promise<T> => {
    signal.throwIfAborted();
    if (++requests > 40) throw new Error('This question exceeds the read budget. Select fewer namespaces.');
    const response = await read<T>(base + path, { signal });
    signal.throwIfAborted();
    return response;
  };
  const objects = async (resource: EvidenceResource, namespaces = scope.namespaces): Promise<KubeObject[]> => {
    const items: KubeObject[] = [];
    const scoped = resource === 'nodes' ? [''] : namespaces.length ? [...new Set(namespaces)] : [''];
    for (const namespace of scoped) {
      let continuation = '';
      const seen = new Set<string>();
      do {
        const params = new URLSearchParams({ limit: '1000' });
        if (namespace) params.set('namespace', namespace);
        if (continuation) params.set('continue', continuation);
        const path = resource === 'secrets' || resource === 'configmaps' ? `/detail/resource-metadata/${resource}` : `/resources/${resourcePaths[resource]}`;
        const page = await get<ListResponse>(`${path}?${params}`);
        if (!Array.isArray(page.items)) throw new Error(`Invalid ${resource} response.`);
        objectsRead += page.items.length;
        continuation = page.continue ?? '';
        if (objectsRead > 10_000 || (continuation && (objectsRead >= 10_000 || seen.has(continuation)))) throw new Error('Too many records or incomplete pagination. Select a narrower scope.');
        items.push(...page.items.filter((obj) => !namespace || obj.metadata.namespace === namespace));
        seen.add(continuation);
      } while (continuation);
    }
    return [...new Map(items.map((obj) => [obj.metadata.uid || `${obj.metadata.namespace}/${obj.metadata.name}`, obj])).values()];
  };
  const href = (resource: EvidenceResource, obj: KubeObject) => `/r/${resourcePaths[resource]}?${new URLSearchParams({ sel: `${scope.context}|${obj.metadata.namespace ?? ''}|${obj.metadata.name}` })}`;
  return { get, objects, href };
}
