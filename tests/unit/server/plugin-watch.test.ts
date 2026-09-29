import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { KubeObject } from '@kubus/shared';
import type { AppContext } from '../../../server/src/app.js';
import type { PluginManager } from '../../../server/src/plugins/manager.js';
import type { WatcherSubscriber } from '../../../server/src/kube/watcher.js';
import { registerWatchSocket } from '../../../server/src/ws/watch-socket.js';

const request = {
  op: 'sub',
  id: 'one',
  ctx: 'cluster',
  group: '',
  version: 'v1',
  plural: 'pods',
  namespace: 'lab',
  namespaceScope: ['lab'],
  pluginId: 'example',
};
const sockets: EventEmitter[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.emit('close');
});
function setup() {
  const socket = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: vi.fn() });
  sockets.push(socket);
  const get = vi.fn(() => ({ manifest: { permissions: { resources: [{ group: '', resources: ['pods', 'secrets'] }] } } }));
  const find = vi.fn().mockResolvedValue({ namespaced: true });
  const release = vi.fn(),
    unsubscribe = vi.fn();
  let subscriber: WatcherSubscriber | undefined;
  const item = { metadata: { name: 'pod', uid: 'uid' }, data: { token: 'private' } } as unknown as KubeObject;
  const watcher = {
    ready: vi.fn().mockResolvedValue(undefined),
    snapshot: () => ({ items: [item], resourceVersion: '1' }),
    currentState: () => 'live',
    subscribe: (value: WatcherSubscriber) => {
      subscriber = value;
      return unsubscribe;
    },
  };
  const acquire = vi.fn(() => ({ watcher, release }));
  const clusters = Object.assign(new EventEmitter(), { get: () => ({ discovery: { find }, watchers: { acquire } }) });
  const app = { get: (_path: string, _options: unknown, handler: (socket: unknown) => void) => handler(socket), log: { warn: vi.fn() } };
  registerWatchSocket(
    app as unknown as FastifyInstance,
    { clusters, portForwards: new EventEmitter() } as unknown as AppContext,
    { get } as unknown as PluginManager,
  );
  const send = async (message: unknown) => {
    socket.emit('message', Buffer.from(JSON.stringify(message)));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    socket,
    get,
    find,
    acquire,
    release,
    unsubscribe,
    watcher,
    send,
    item,
    subscriber: () => subscriber!,
    messages: () => socket.send.mock.calls.map(([m]) => JSON.parse(m)),
  };
}
describe('plugin watch boundary', () => {
  it.each([
    { ...request, plural: 'configmaps' },
    { ...request, namespace: 'other' },
    { ...request, namespace: undefined },
    { ...request, version: '../v1' },
  ])('rejects undeclared resources, namespace escapes and invalid paths before acquiring a watcher', async (input) => {
    const f = setup();
    await f.send(input);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.messages()).toEqual([expect.objectContaining({ op: 'status', state: 'error' })]);
  });
  it('streams snapshots/deltas and revokes the subscription before forwarding data after disablement', async () => {
    const f = setup();
    await f.send(request);
    expect(f.messages()[0]).toMatchObject({ op: 'snapshot', items: [f.item] });
    f.subscriber().onDeltas([{ type: 'MODIFIED', object: f.item }]);
    expect(f.messages().at(-1)).toMatchObject({ op: 'events' });
    f.get.mockImplementation(() => {
      throw new Error('Plugin is disabled');
    });
    f.subscriber().onDeltas([{ type: 'DELETED', object: f.item }]);
    expect(f.messages().at(-1)).toMatchObject({ op: 'status', state: 'error', message: 'Plugin is disabled' });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it('redacts secrets in both snapshots and events', async () => {
    const f = setup();
    await f.send({ ...request, plural: 'secrets' });
    f.subscriber().onDeltas([{ type: 'ADDED', object: f.item }]);
    expect(JSON.stringify(f.messages())).not.toContain('private');
  });
  it('cancels pending discovery and releases an active watch on unsubscribe', async () => {
    const f = setup();
    let resolve!: (value: unknown) => void;
    f.find.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await f.send(request);
    await f.send({ op: 'unsub', id: request.id });
    resolve({ namespaced: true });
    await new Promise((done) => setImmediate(done));
    expect(f.acquire).not.toHaveBeenCalled();
    await f.send(request);
    await f.send({ op: 'unsub', id: request.id });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
});
