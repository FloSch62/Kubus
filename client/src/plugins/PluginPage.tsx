import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useTheme } from '@mui/material/styles';
import {
  pluginCanRead,
  type PluginContext,
  type PluginInfo,
  type PluginRequest,
  type KubeObject,
  type ResourceKindInfo,
} from '@kubus/shared';
import { apiFetch, ApiError } from '../api/http.js';
import { useClustersStore } from '../state/clusters.js';
import { useDetailStore } from '../state/detail.js';
import { dockTabId, useDockStore } from '../state/dock.js';
import { useRefetchInterval } from '../state/prefs.js';
import { usePaneActive } from '../layout/pane-context.js';
import { usePlugins } from './queries.js';

import { helmReleaseFor } from '@kubus/plugin-sdk';
import { assertPluginScope } from './scope.js';
import { resolvePluginContainer } from './pod-container.js';

function PluginFrame({ plugin }: { plugin: PluginInfo }) {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const iframe = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const selected = useClustersStore((s) => s.selected);
  const namespacesByContext = useClustersStore((s) => s.namespacesByContext);
  const theme = useTheme();
  const active = usePaneActive();
  const refreshInterval = useRefetchInterval(10_000);
  const context = useMemo<PluginContext>(
    () => ({
      contexts: selected,
      namespacesByContext: Object.fromEntries(selected.map((ctx) => [ctx, namespacesByContext[ctx] ?? []])),
      theme: theme.palette.mode,
      active,
      refreshInterval,
    }),
    [selected, namespacesByContext, theme.palette.mode, active, refreshInterval],
  );
  const latest = useRef({ context, plugin });
  latest.current = { context, plugin };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [restart, setRestart] = useState(0);

  useEffect(() => {
    for (const controller of controllers.current) controller.abort();
  }, [selected, namespacesByContext, active]);
  useEffect(() => {
    port.current?.postMessage({ type: 'kubus:context', context });
  }, [context]);

  const connect = useCallback(() => {
    port.current?.close();
    for (const controller of controllers.current) controller.abort();
    const channel = new MessageChannel();
    port.current = channel.port1;
    setReady(false);
    setError('');
    let inFlight = 0;
    channel.port1.onmessage = async (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== 'object') return;
      if ('type' in event.data && event.data.type === 'kubus:ready') {
        setReady(true);
        return;
      }
      const request = event.data as PluginRequest;
      if (request.type !== 'kubus:request' || typeof request.id !== 'string' || request.id.length > 100) return;
      const respond = (result?: unknown, failure?: unknown) => {
        if (port.current !== channel.port1) return;
        channel.port1.postMessage({
          type: 'kubus:response',
          id: request.id,
          result,
          error: failure
            ? {
                message: failure instanceof Error ? failure.message : 'Plugin request failed',
                status: failure instanceof ApiError ? failure.status : undefined,
              }
            : undefined,
        });
      };
      if (inFlight >= 24) {
        respond(undefined, new Error('Too many concurrent plugin requests'));
        return;
      }
      const controller = new AbortController();
      controllers.current.add(controller);
      inFlight++;
      try {
        const { plugin: current, context: scope } = latest.current;
        const p = request.params;
        if (!p || typeof p !== 'object') throw new Error('Invalid plugin request');
        assertPluginScope(scope, p, false);
        if (!current.enabled || !pluginCanRead(current.manifest, p.group, p.plural)) throw new Error('Plugin permission denied');
        if (
          !['resources.list', 'resources.get', 'resource.open', 'pod.logs', 'pod.terminal', 'pod.interfaces', 'helm.open'].includes(
            request.method,
          )
        )
          throw new Error('Unsupported plugin method');
        const action = request.method !== 'resources.list' && request.method !== 'resources.get';
        if (
          action &&
          !current.manifest.permissions.actions.includes(
            request.method as 'resource.open' | 'pod.logs' | 'pod.terminal' | 'pod.interfaces' | 'helm.open',
          )
        )
          throw new Error('Plugin action permission denied');
        if (request.method !== 'resources.list' && !p.name) throw new Error('A resource name is required');
        if (request.method === 'resources.list' && p.name) throw new Error('List requests cannot contain a resource name');
        if (request.method.startsWith('pod.') && (p.group !== '' || p.version !== 'v1' || p.plural !== 'pods' || !p.namespace))
          throw new Error('This action requires a namespaced Pod');
        if (request.method === 'pod.interfaces') {
          const result = await apiFetch(`/api/plugins/${current.manifest.id}/interfaces`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...p, namespaceScope: scope.namespacesByContext[p.ctx] ?? [] }),
            signal: controller.signal,
          });
          if (controller.signal.aborted) throw new Error('Plugin context changed');
          assertPluginScope(latest.current.context, p, true);
          respond(result);
          return;
        }
        // Do not forward arbitrary fields, paths or methods supplied by a plugin.
        const { container, ...resource } = p;
        const response = await apiFetch<{ data: KubeObject; kind: ResourceKindInfo }>(`/api/plugins/${current.manifest.id}/resources`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...resource, namespaceScope: scope.namespacesByContext[p.ctx] ?? [] }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw new Error('Plugin context changed');
        assertPluginScope(latest.current.context, p, response.kind.namespaced);
        if (request.method === 'helm.open') {
          const release = helmReleaseFor(response.data.metadata);
          if (!release) throw new Error('This resource has no Helm release ownership metadata');
          assertPluginScope(latest.current.context, { ...p, namespace: release.namespace }, true);
          void navigateRef.current(
            `/helm/${encodeURIComponent(p.ctx)}/${encodeURIComponent(release.namespace)}/${encodeURIComponent(release.name)}`,
          );
        } else if (request.method === 'resource.open') {
          useDetailStore.getState().open({
            ctx: p.ctx,
            group: p.group,
            version: p.version,
            plural: p.plural,
            namespace: p.namespace,
            name: p.name!,
            kind: response.kind.kind,
            custom: response.kind.custom,
          });
        } else if (request.method === 'pod.logs' || request.method === 'pod.terminal') {
          const chosen = resolvePluginContainer(response.data, request.method, container);
          if (request.method === 'pod.logs')
            useDockStore.getState().addTab({
              kind: 'logs',
              id: dockTabId(),
              title: p.name!,
              ctx: p.ctx,
              namespace: p.namespace!,
              pods: [p.name!],
              container: chosen,
            });
          else
            useDockStore.getState().addTab({
              kind: 'terminal',
              id: dockTabId(),
              title: p.name!,
              ctx: p.ctx,
              namespace: p.namespace!,
              pod: p.name!,
              container: chosen,
            });
        }
        respond(action ? null : response.data);
      } catch (failure) {
        respond(undefined, failure);
      } finally {
        inFlight--;
        controllers.current.delete(controller);
      }
    };
    channel.port1.start();
    // The target has an opaque origin. The transferred port is scoped to this
    // specific iframe; there is no global request listener accepting other frames.
    iframe.current?.contentWindow?.postMessage({ type: 'kubus:connect', apiVersion: 1, context: latest.current.context }, '*', [
      channel.port2,
    ]);
  }, []);

  useEffect(
    () => () => {
      port.current?.close();
      port.current = null;
      for (const controller of controllers.current) controller.abort();
    },
    [],
  );
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setError('The plugin did not load. Reload it to try again.'), 15_000);
    return () => clearTimeout(timer);
  }, [ready, restart]);

  return (
    <Box sx={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {error && (
        <Alert
          severity="error"
          action={
            <Button
              onClick={() => {
                setError('');
                setReady(false);
                setRestart((n) => n + 1);
              }}
            >
              Reload plugin
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {!ready && !error && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <CircularProgress size={24} />
        </Box>
      )}
      <iframe
        key={restart}
        ref={iframe}
        title={plugin.manifest.name}
        src={`/plugin-assets/${plugin.manifest.id}/${plugin.manifest.entry}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={connect}
        onError={() => setError('Unable to load this plugin')}
        style={{ border: 0, width: '100%', flex: 1, minHeight: 0 }}
      />
    </Box>
  );
}

export function PluginPage() {
  const { id } = useParams();
  const plugins = usePlugins();
  const plugin = plugins.data?.find((p) => p.manifest.id === id);
  if (plugins.isPending) return <CircularProgress sx={{ m: 3 }} size={24} />;
  if (plugins.error) return <Alert severity="error">{plugins.error.message}</Alert>;
  if (!plugin?.enabled)
    return (
      <Alert severity="info" sx={{ m: 3 }}>
        This plugin is disabled or unavailable. Manage plugins in Settings → Plugins.
      </Alert>
    );
  return <PluginFrame key={`${plugin.manifest.id}@${plugin.manifest.version}`} plugin={plugin} />;
}
