import { useLogPrefsStore } from './state/log-prefs.js';

const EXTERNAL_STATE_EVENT = 'kubus:state-changed';

interface PersistApi {
  persist: { rehydrate: () => Promise<void> | void };
}

const storeLoaders: Record<string, () => Promise<PersistApi>> = {
  'kubus-audit': () => import('./state/audit.js').then((module) => module.useAuditPrefsStore),
  'kubus-clusters': () => import('./state/clusters.js').then((module) => module.useClustersStore),
  'kubus-log-prefs': () => Promise.resolve(useLogPrefsStore),
  'kubus-navigation': () => import('./state/navigation.js').then((module) => module.useNavigationStore),
  'kubus-portforward-prefs': () => import('./state/portforward-prefs.js').then((module) => module.usePortForwardPrefsStore),
  'kubus-prefs': () => import('./state/prefs.js').then((module) => module.useUiPrefsStore),
};

let installed = false;

function rehydrate(name: string | null): void {
  if (!name) return;
  const load = storeLoaders[name];
  if (load) void load().then((store) => store.persist.rehydrate());
}

/**
 * Keep durable app-wide preferences and saved definitions live. Cluster and
 * UI stores deliberately partialize their persisted state, so rehydration
 * cannot replace a window's selected contexts, namespaces, or nav layout.
 */
export function installCrossWindowStateSync(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('storage', (event) => rehydrate(event.key));
  window.addEventListener(EXTERNAL_STATE_EVENT, (event) => {
    const name = (event as CustomEvent<{ name?: unknown }>).detail?.name;
    if (typeof name === 'string') rehydrate(name);
  });
}
