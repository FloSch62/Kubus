export { helmReleaseFor } from './metadata.js';
import type {
  PluginContext,
  PluginHostMessage,
  PluginMethod,
  PluginRequest,
  PluginResourceRequest,
  PodInterfaceSnapshot,
  PluginWatchRequest,
  PluginWatchUpdate,
  PluginWatchMessage,
} from './protocol.js';
export type {
  PluginManifest,
  PluginContext,
  PluginResourceRequest,
  PodInterfaceSnapshot,
  PluginWatchRequest,
  PluginWatchUpdate,
} from './protocol.js';

export class PluginError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
/** Create once per page; dispose on teardown. No credentials or host imports. */
export function connectPlugin(onContext: (context: PluginContext) => void) {
  let port: MessagePort | undefined;
  let sequence = 0;
  let disposed = false;
  const watches = new Map<string, { params: PluginWatchRequest; update: (update: PluginWatchUpdate) => void }>();
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const rejectPending = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new PluginError('Plugin connection closed'));
    }
    pending.clear();
  };
  const connect = (event: MessageEvent) => {
    if (
      disposed ||
      event.source !== window.parent ||
      event.data?.type !== 'kubus:connect' ||
      event.data.apiVersion !== 1 ||
      !event.ports[0]
    )
      return;
    port?.close();
    rejectPending();
    const connectedPort = event.ports[0];
    port = connectedPort;
    port.onmessage = (message: MessageEvent<PluginHostMessage>) => {
      if (disposed || port !== connectedPort) return;
      if (message.data.type === 'kubus:context') {
        onContext(message.data.context);
        return;
      }
      if (message.data.type === 'kubus:watch-update') {
        watches.get(message.data.id)?.update(message.data.update);
        return;
      }
      if (message.data.type !== 'kubus:response') return;
      const response = pending.get(message.data.id);
      if (!response) return;
      pending.delete(message.data.id);
      clearTimeout(response.timer);
      if (message.data.error) response.reject(new PluginError(message.data.error.message, message.data.error.status));
      else response.resolve(message.data.result);
    };
    port.start();
    port.postMessage({ type: 'kubus:ready' });
    onContext(event.data.context as PluginContext);
    for (const [id, watch] of watches) port.postMessage({ type: 'kubus:watch', id, params: watch.params } satisfies PluginWatchMessage);
  };
  window.addEventListener('message', connect);
  const request = <T>(method: PluginMethod, params: PluginRequest['params']): Promise<T> =>
    new Promise((resolve, reject) => {
      if (!port || disposed) {
        reject(new PluginError('Plugin is not connected to Kubus'));
        return;
      }
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PluginError('Plugin request timed out'));
      }, 30_000);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      port.postMessage({ type: 'kubus:request', id, method, params } satisfies PluginRequest);
    });
  return {
    /** Initial snapshot followed by batched changes; call the returned function on scope changes or teardown. */
    watch: <T>(params: PluginWatchRequest, update: (update: PluginWatchUpdate<T>) => void): (() => void) => {
      if (!port || disposed) {
        update({ kind: 'status', state: 'error', message: 'Plugin is not connected to Kubus' });
        return () => {};
      }
      const id = String(++sequence);
      watches.set(id, { params, update: update as (update: PluginWatchUpdate) => void });
      port.postMessage({ type: 'kubus:watch', id, params } satisfies PluginWatchMessage);
      return () => {
        if (!watches.delete(id)) return;
        port?.postMessage({ type: 'kubus:unwatch', id } satisfies PluginWatchMessage);
      };
    },
    list: <T>(params: PluginResourceRequest) => request<{ items: T[]; continue?: string }>('resources.list', params),
    get: <T>(params: PluginResourceRequest & { name: string }) => request<T>('resources.get', params),
    openHelmRelease: (params: PluginResourceRequest & { name: string }) => request<void>('helm.open', params),
    openResource: (params: PluginResourceRequest & { name: string }) => request<void>('resource.open', params),
    openLogs: (params: PluginResourceRequest & { name: string; container?: string }) => request<void>('pod.logs', params),
    openTerminal: (params: PluginResourceRequest & { name: string; container?: string }) => request<void>('pod.terminal', params),
    readPodInterfaces: (params: PluginResourceRequest & { name: string; container: string }) =>
      request<PodInterfaceSnapshot>('pod.interfaces', params),
    dispose: () => {
      disposed = true;
      for (const id of watches.keys()) port?.postMessage({ type: 'kubus:unwatch', id } satisfies PluginWatchMessage);
      watches.clear();
      window.removeEventListener('message', connect);
      port?.close();
      rejectPending();
    },
  };
}
export type PluginClient = ReturnType<typeof connectPlugin>;
