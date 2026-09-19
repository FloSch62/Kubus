import type { PluginContext, PluginResourceRequest } from '@kubus/shared';

/** Scope checks are repeated on completion so stale results cannot cross a context switch. */
export function assertPluginScope(context: PluginContext, params: PluginResourceRequest, namespaced = true): void {
  if (!context.active || !context.contexts.includes(params.ctx)) throw new Error('Choose an active cluster before using this plugin');
  const namespaces = context.namespacesByContext[params.ctx] ?? [];
  if (namespaced && namespaces.length && (!params.namespace || !namespaces.includes(params.namespace))) {
    throw new Error('Resource is outside the selected namespaces');
  }
}
