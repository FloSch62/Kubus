import type { PluginClient, PluginContext, PluginWatchRequest } from '@kubus/plugin-sdk';
import type { Located, Resource } from './model.js';

export interface Collection {
  group: string;
  plural: string;
  version?: string;
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

/** Each collection owns its cache; failures never discard healthy clusters or namespaces. */
export function watchCollections(
  client: PluginClient,
  context: PluginContext,
  collections: Collection[],
  publish: (snapshot: Snapshot, loading: boolean) => void,
  previous?: Snapshot,
): () => void {
  const tasks: PluginWatchRequest[] = context.contexts.flatMap((ctx) => {
    const namespaces = context.namespacesByContext[ctx]?.length ? context.namespacesByContext[ctx]! : [undefined];
    return namespaces.flatMap((namespace) => collections.map((c) => ({ ctx, namespace, ...c, version: c.version ?? 'v1alpha1' })));
  });
  const identity = (r: Resource) => r.metadata.uid ?? `${r.metadata.namespace ?? ''}/${r.metadata.name}`;
  // Resume each collection independently without emptying the others while their snapshots arrive.
  const states = tasks.map((request) => ({
    items: new Map(
      (previous?.items ?? [])
        .filter(
          (r) =>
            r.ctx === request.ctx &&
            r.group === request.group &&
            r.plural === request.plural &&
            r.apiVersion === (request.group ? `${request.group}/${request.version}` : request.version) &&
            (!request.namespace || r.metadata.namespace === request.namespace),
        )
        .map((r) => [identity(r), r]),
    ),
    pending: true,
    error: undefined as Snapshot['errors'][number] | undefined,
  }));
  let disposed = false;
  const emit = () => {
    if (disposed) return;
    publish(
      {
        items: states.flatMap((s) => [...s.items.values()]),
        errors: states.flatMap((s) => (s.error ? [s.error] : [])),
        updated: Date.now(),
      },
      states.some((s) => s.pending),
    );
  };
  const stops = tasks.map((request, index) => {
    const state = states[index]!;
    const locate = (r: Resource): Located => ({
      ...r,
      ctx: request.ctx,
      plural: request.plural,
      group: request.group,
      apiVersion: r.apiVersion ?? (request.group ? `${request.group}/${request.version}` : request.version),
    });
    return client.watch<Resource>(request, (update) => {
      if (disposed) return;
      if (update.kind === 'snapshot') {
        state.items = new Map(update.items.map((r) => [identity(r), locate(r)]));
        state.pending = false;
      } else if (update.kind === 'events') {
        for (const event of update.events) {
          if (event.type === 'DELETED') state.items.delete(identity(event.object));
          else state.items.set(identity(event.object), locate(event.object));
        }
      } else {
        state.error =
          update.state === 'live'
            ? undefined
            : {
                ctx: request.ctx,
                namespace: request.namespace,
                plural: request.plural,
                message:
                  update.message ?? (update.state === 'reconnecting' ? 'Reconnecting to live updates…' : 'Resource watch unavailable'),
                status: update.state === 'unavailable' ? 404 : undefined,
              };
        if (update.state === 'error' || update.state === 'unavailable') state.pending = false;
      }
      emit();
    });
  });
  if (!tasks.length) emit();
  return () => {
    disposed = true;
    for (const stop of stops) stop();
  };
}
