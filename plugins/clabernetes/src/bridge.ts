import { connectPlugin, type PluginContext } from '@kubus/plugin-sdk';
import { useSyncExternalStore } from 'react';
let context: PluginContext = { contexts: [], namespacesByContext: {}, theme: 'dark', active: false, refreshInterval: false };
const listeners = new Set<() => void>();
export const client = connectPlugin((next) => {
  context = next;
  document.documentElement.dataset.theme = next.theme;
  for (const listener of listeners) listener();
});
export function useContext() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => context,
  );
}
window.addEventListener('pagehide', () => client.dispose(), { once: true });
