import { describe, expect, it, vi } from 'vitest';
import { connectPlugin } from '../../../plugins/sdk/src/index.js';
import type { PluginContext } from '@kubus/shared';
import { assertPluginScope } from '../../../client/src/plugins/scope.js';

const context: PluginContext = {
  contexts: ['cluster-a'],
  namespacesByContext: { 'cluster-a': ['lab'] },
  active: true,
  theme: 'dark',
  refreshInterval: 10000,
};
const resource = { ctx: 'cluster-a', group: 'c9s.run', version: 'v1alpha1', plural: 'nodes', namespace: 'lab' };
describe('plugin window scope', () => {
  it('rejects other clusters, other namespaces, all-namespace escapes, and hidden panes', () => {
    expect(() => assertPluginScope(context, resource)).not.toThrow();
    expect(() => assertPluginScope(context, { ...resource, ctx: 'cluster-b' })).toThrow();
    expect(() => assertPluginScope(context, { ...resource, namespace: 'other' })).toThrow();
    expect(() => assertPluginScope(context, { ...resource, namespace: undefined })).toThrow();
    expect(() => assertPluginScope({ ...context, active: false }, resource)).toThrow();
    expect(() => assertPluginScope({ ...context, namespacesByContext: {} }, { ...resource, namespace: undefined })).not.toThrow();
  });
});

function fakePort() {
  return { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((message: MessageEvent) => void) | null };
}
describe('SDK connection lifecycle', () => {
  it('accepts a transferred port only from the parent and correlates responses', async () => {
    const onContext = vi.fn();
    const sdk = connectPlugin(onContext);
    const port = fakePort();
    const data = { type: 'kubus:connect', apiVersion: 1, context };
    window.dispatchEvent(new MessageEvent('message', { data, ports: [port as unknown as MessagePort] }));
    expect(onContext).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { source: window, data, ports: [port as unknown as MessagePort] }));
    expect(onContext).toHaveBeenCalledWith(context);
    const result = sdk.list(resource);
    const request = port.postMessage.mock.calls.at(-1)?.[0] as { id: string; method: string };
    expect(request.method).toBe('resources.list');
    port.onmessage?.(new MessageEvent('message', { data: { type: 'kubus:response', id: request.id, result: { items: [] } } }));
    await expect(result).resolves.toEqual({ items: [] });
    sdk.dispose();
    expect(port.close).toHaveBeenCalledOnce();
  });
  it('rejects outstanding work when disposed and never reconnects after cleanup', async () => {
    const onContext = vi.fn();
    const sdk = connectPlugin(onContext);
    const port = fakePort();
    const message = () =>
      new MessageEvent('message', {
        source: window,
        data: { type: 'kubus:connect', apiVersion: 1, context },
        ports: [port as unknown as MessagePort],
      });
    window.dispatchEvent(message());
    const result = sdk.list(resource);
    sdk.dispose();
    await expect(result).rejects.toThrow('connection closed');
    window.dispatchEvent(message());
    expect(onContext).toHaveBeenCalledOnce();
    await expect(sdk.list(resource)).rejects.toThrow('not connected');
  });
});

it('streams updates, resubscribes after port replacement, and ignores messages after stopping', () => {
  const sdk = connectPlugin(vi.fn());
  const connect = (port: ReturnType<typeof fakePort>) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: 'kubus:connect', apiVersion: 1, context },
        ports: [port as unknown as MessagePort],
      }),
    );
  const first = fakePort();
  connect(first);
  const update = vi.fn();
  const stop = sdk.watch(resource, update);
  const watch = first.postMessage.mock.lastCall?.[0];
  expect(watch).toMatchObject({ type: 'kubus:watch', params: resource });
  const deliver = (port: ReturnType<typeof fakePort>, data: unknown) =>
    port.onmessage?.(
      new MessageEvent('message', {
        data: { type: 'kubus:watch-update', id: watch.id, update: data },
      }),
    );
  deliver(first, { kind: 'snapshot', items: [] });
  expect(update).toHaveBeenCalledWith({ kind: 'snapshot', items: [] });
  const second = fakePort();
  connect(second);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.postMessage).toHaveBeenCalledWith(watch);
  deliver(first, { kind: 'snapshot', items: ['stale'] });
  expect(update).toHaveBeenCalledTimes(1);
  deliver(second, { kind: 'status', state: 'live' });
  expect(update).toHaveBeenCalledTimes(2);
  stop();
  stop();
  expect(second.postMessage.mock.calls.filter(([m]) => m.type === 'kubus:unwatch')).toHaveLength(1);
  deliver(second, { kind: 'events', events: [] });
  expect(update).toHaveBeenCalledTimes(2);
  sdk.dispose();
});
