import { PluginError, type PluginClient, type PluginContext, type PluginResourceRequest } from '@kubus/plugin-sdk';
import type { Located, Resource } from './model.js';

export interface Collection {
  group: string;
  plural: string;
  version?: string;
  labelSelector?: string;
}
export interface Snapshot {
  items: Located[];
  errors: Array<{ ctx: string; plural: string; namespace?: string; message: string; status?: number }>;
  updated: number;
}
export const catalog: Collection[] = ['topologies', 'nodes', 'links', 'nodeprofiles', 'configs'].map((plural) => ({
  group: 'c9s.run',
  plural,
}));
export const runtime: Collection[] = [
  { group: '', plural: 'pods', version: 'v1' },
  { group: '', plural: 'services', version: 'v1' },
  { group: '', plural: 'events', version: 'v1' },
  { group: '', plural: 'persistentvolumeclaims', version: 'v1' },
  { group: 'apps', plural: 'deployments', version: 'v1' },
];

/** Bounded concurrency, complete pagination, and per-resource errors for mixed clusters/RBAC. */
export async function readCollections(
  client: PluginClient,
  context: PluginContext,
  collections: Collection[],
  cancelled: () => boolean,
): Promise<Snapshot> {
  const result: Snapshot = { items: [], errors: [], updated: 0 };
  const tasks: PluginResourceRequest[] = context.contexts.flatMap((ctx) => {
    const namespaces = context.namespacesByContext[ctx]?.length ? context.namespacesByContext[ctx]! : [undefined];
    return namespaces.flatMap((namespace) => collections.map((c) => ({ ctx, namespace, ...c, version: c.version ?? 'v1alpha1' })));
  });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, tasks.length) }, async () => {
      while (next < tasks.length && !cancelled()) {
        const request = tasks[next++]!;
        try {
          let token: string | undefined;
          const tokens = new Set<string>();
          do {
            const page = await client.list<Resource>({ ...request, continue: token });
            if (cancelled()) return;
            result.items.push(
              ...page.items.map((r) => ({
                ...r,
                ctx: request.ctx,
                plural: request.plural,
                group: request.group,
                apiVersion: r.apiVersion ?? (request.group ? `${request.group}/${request.version}` : request.version),
              })),
            );
            token = page.continue;
            if (token && tokens.has(token)) throw new Error('Cluster returned a repeated pagination token');
            if (token) tokens.add(token);
          } while (token && !cancelled());
        } catch (error) {
          result.errors.push({
            ctx: request.ctx,
            namespace: request.namespace,
            plural: request.plural,
            message: error instanceof Error ? error.message : String(error),
            status: error instanceof PluginError ? error.status : undefined,
          });
        }
      }
    }),
  );
  result.updated = Date.now();
  return result;
}
