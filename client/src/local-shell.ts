import { useClustersStore } from './state/clusters.js';
import { dockTabId, localShellTitle, useDockStore, type LocalShellTab } from './state/dock.js';

export interface OpenLocalShellOptions {
  /** Context to point at; defaults to the first selected cluster. */
  ctx?: string;
  /** Namespace to point at; defaults to the cluster's current namespace filter (first entry). */
  namespace?: string;
  /** Typed into the shell and run once it is ready. */
  command?: string;
  /**
   * Reuse a tab already pointed at this cluster instead of opening another
   * (default for commands). A reused tab keeps the namespace it is on, since a
   * queued command names its own namespace and the tab's kubeconfig must stay
   * what the shell was told it is.
   */
  reuse?: boolean;
}

/** The cluster and namespace the UI is on right now — where a fresh terminal should start. */
export function currentShellTarget(): { ctx: string | undefined; namespace: string | undefined } {
  const clusters = useClustersStore.getState();
  const ctx = clusters.selected[0];
  return { ctx, namespace: ctx ? clusters.namespacesByContext[ctx]?.[0] : undefined };
}

/**
 * Open (or focus) a Terminal tab in the dock whose shell already points at
 * the cluster and namespace in view. Returns the tab id, or undefined when
 * no cluster is selected.
 */
export function openLocalShell(opts: OpenLocalShellOptions = {}): string | undefined {
  const target = currentShellTarget();
  const ctx = opts.ctx ?? target.ctx;
  if (!ctx) return undefined;
  const namespace = opts.namespace ?? (opts.ctx ? undefined : target.namespace);
  const dock = useDockStore.getState();
  const reuse = opts.reuse ?? !!opts.command;
  const existing = reuse ? dock.tabs.find((tab): tab is LocalShellTab => tab.kind === 'local-shell' && tab.ctx === ctx) : undefined;
  if (existing) {
    dock.setLocalShell(existing.id, { pendingCommand: opts.command });
    dock.requestTerminalFocus(existing.id);
    return existing.id;
  }
  const id = dockTabId();
  // Following the selection is the default: the terminal tracks the cluster
  // switcher until the user pins it to a cluster from the tab's own picker.
  const follow = !opts.ctx;
  dock.addTab({ kind: 'local-shell', id, title: localShellTitle(ctx, namespace), ctx, namespace, follow, pendingCommand: opts.command });
  dock.requestTerminalFocus(id);
  return id;
}
