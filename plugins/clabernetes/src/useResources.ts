import { useEffect, useEffectEvent, useState } from 'react';
import { client, useContext } from './bridge.js';
import { watchCollections, type Collection, type Snapshot } from './data.js';
import { usePaneActive } from './ViewPane.js';
const EMPTY: Snapshot = { items: [], errors: [], updated: 0 };

export function useResources(
  collections: Collection[],
  scope?: { ctx: string; namespace?: string } | { labs: Array<{ ctx: string; namespace: string }> },
  enabled = true,
) {
  const context = useContext();
  const active = usePaneActive() && context.active;
  const [state, setState] = useState<{ snapshot: Snapshot; loading: boolean; scopeKey: string }>({
    snapshot: EMPTY,
    loading: false,
    scopeKey: '',
  });
  const scopeKey = JSON.stringify([context.contexts, context.namespacesByContext, scope]);
  const subscribe = useEffectEvent(() => {
    const scoped =
      scope && 'labs' in scope
        ? {
            ...context,
            contexts: [...new Set(scope.labs.map((l) => l.ctx))],
            namespacesByContext: Object.fromEntries(
              [...new Set(scope.labs.map((l) => l.ctx))].map((ctx) => [
                ctx,
                [...new Set(scope.labs.filter((l) => l.ctx === ctx).map((l) => l.namespace))],
              ]),
            ),
          }
        : scope
          ? { ...context, contexts: [scope.ctx], namespacesByContext: { [scope.ctx]: scope.namespace ? [scope.namespace] : [] } }
          : context;
    return watchCollections(
      client,
      scoped,
      collections,
      (snapshot, loading) => setState({ snapshot, loading, scopeKey }),
      state.scopeKey === scopeKey ? state.snapshot : undefined,
    );
  });
  useEffect(() => {
    if (!active || !enabled) return;
    setState((s) => ({ snapshot: s.scopeKey === scopeKey ? s.snapshot : EMPTY, loading: true, scopeKey }));
    return subscribe();
    // JSON identity captures selected cluster/namespace scope; theme does not refetch data.
  }, [scopeKey, active, collections, enabled]);
  return { snapshot: state.scopeKey === scopeKey ? state.snapshot : EMPTY, loading: state.loading };
}
