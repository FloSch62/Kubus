import { useEffect, useEffectEvent, useState } from 'react';
import { client, useContext } from './bridge.js';
import { readCollections, type Collection, type Snapshot } from './data.js';
const EMPTY: Snapshot = { items: [], errors: [], updated: 0 };

export function useResources(
  collections: Collection[],
  scope?: { ctx: string; namespace?: string } | { labs: Array<{ ctx: string; namespace: string }> },
  refresh = 0,
  enabled = true,
) {
  const context = useContext();
  const [state, setState] = useState<{ snapshot: Snapshot; loading: boolean; scopeKey: string }>({
    snapshot: EMPTY,
    loading: false,
    scopeKey: '',
  });
  const scopeKey = JSON.stringify([context.contexts, context.namespacesByContext, scope]);
  const fetchSnapshot = useEffectEvent((cancelled: () => boolean) => {
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
    return readCollections(client, scoped, collections, cancelled);
  });
  useEffect(() => {
    if (!context.active || !enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setState((s) => ({ snapshot: s.scopeKey === scopeKey ? s.snapshot : EMPTY, loading: true, scopeKey }));
      const snapshot = await fetchSnapshot(() => disposed);
      if (disposed) return;
      setState({ snapshot, loading: false, scopeKey });
      if (context.refreshInterval) timer = setTimeout(() => void read(), context.refreshInterval);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
    // JSON identity captures selected cluster/namespace scope; theme does not refetch data.
  }, [scopeKey, context.active, context.refreshInterval, collections, refresh, enabled]);
  return { snapshot: state.scopeKey === scopeKey ? state.snapshot : EMPTY, loading: state.loading };
}
