import { useEffect, useEffectEvent, useState } from 'react';
import { client, useContext } from './bridge.js';
import { key, ref, type Located } from './model.js';
import { interfaceTarget, type InterfaceObservation } from './interfaces.js';
import { usePaneActive } from './ViewPane.js';

/** Automatically sample running applications; scope/Pod changes invalidate observations. */
export function useInterfaces(nodes: Located[], pods: Located[], enabled: boolean) {
  const context = useContext();
  const active = usePaneActive() && context.active;
  const targets = nodes.map((node) => ({ node, target: interfaceTarget(node, pods) }));
  const identity = JSON.stringify(
    targets.map(({ node, target }) => [
      key(node),
      node.metadata.uid,
      target?.pod.metadata.name,
      target?.pod.metadata.uid,
      target?.name,
      target?.restarts,
    ]),
  );
  const [state, setState] = useState<{ identity: string; data: Record<string, InterfaceObservation>; loading: boolean }>({
    identity: '',
    data: {},
    loading: false,
  });
  const read = useEffectEvent(async (cancelled: () => boolean) => {
    const data: Record<string, InterfaceObservation> = {};
    setState((s) => ({
      identity,
      data: Object.fromEntries(
        targets.map(({ node }) => [key(node), { ...(s.identity === identity ? s.data[key(node)] : {}), pending: true }]),
      ),
      loading: true,
    }));
    // Several logical Nodes can share a network namespace; deduplicate identical container requests.
    const requests = new Map<string, Promise<InterfaceObservation>>();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (next < targets.length && !cancelled()) {
          const { node, target } = targets[next++]!;
          let result: InterfaceObservation;
          if (!target) result = { error: 'No running application container. Check device readiness.' };
          else {
            const id = `${key(target.pod)}/${target.name}`;
            let request = requests.get(id);
            if (!request) {
              request = client
                .readPodInterfaces({ ...ref(target.pod), container: target.name })
                .then((snapshot) =>
                  snapshot.podUID && target.pod.metadata.uid && snapshot.podUID !== target.pod.metadata.uid
                    ? { error: 'Pod was replaced during inspection. Waiting for its replacement.' }
                    : { snapshot },
                )
                .catch((e: Error) => ({ error: e.message }));
              requests.set(id, request);
            }
            result = await request;
          }
          if (cancelled()) return;
          data[key(node)] = result;
          setState((s) => ({ identity, data: { ...s.data, [key(node)]: result }, loading: true }));
        }
      }),
    );
    if (!cancelled()) setState({ identity, data, loading: false });
  });
  useEffect(() => {
    if (!enabled || !active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await read(() => disposed);
      if (!disposed && context.refreshInterval) timer = setTimeout(() => void poll(), Math.max(10000, context.refreshInterval));
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [identity, enabled, active, context.refreshInterval]);
  return state.identity === identity ? state : { data: {}, loading: enabled, identity };
}
