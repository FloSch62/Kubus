import { describe, expect, it, vi } from 'vitest';
import { watchCollections, type Snapshot } from '../../../plugins/clabernetes/src/data.js';
import type { PluginClient, PluginContext, PluginWatchRequest, PluginWatchUpdate } from '../../../plugins/sdk/src/index.js';
import type { Resource } from '../../../plugins/clabernetes/src/model.js';

const context: PluginContext = {
  contexts: ['a', 'b'],
  namespacesByContext: { a: ['lab', 'team'] },
  active: true,
  theme: 'light',
  refreshInterval: false,
};
const item = (name: string, uid = name): Resource => ({ metadata: { name, uid, namespace: 'lab' } });
function fixture(previous?: Snapshot) {
  const subscriptions: Array<{
    params: PluginWatchRequest;
    update: (event: PluginWatchUpdate<Resource>) => void;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const watch = vi.fn((params, update) => {
    const stop = vi.fn();
    subscriptions.push({ params, update, stop });
    return stop;
  });
  const publish = vi.fn();
  const stop = watchCollections({ watch } as unknown as PluginClient, context, [{ group: 'c9s.run', plural: 'nodes' }], publish, previous);
  return { subscriptions, publish, stop };
}
describe('c9s collection streams', () => {
  it('keeps previous rows until each resumed collection supplies its own snapshot', () => {
    const first = fixture();
    first.subscriptions[0]!.update({ kind: 'snapshot', items: [item('lab-node')] });
    first.subscriptions[1]!.update({
      kind: 'snapshot',
      items: [{ ...item('team-node'), metadata: { name: 'team-node', uid: 'team', namespace: 'team' } }],
    });
    first.subscriptions[2]!.update({ kind: 'snapshot', items: [item('other-cluster')] });
    const previous = first.publish.mock.lastCall?.[0] as Snapshot;
    first.stop();
    const resumed = fixture({ ...previous, items: [...previous.items, { ...previous.items[0]!, ctx: 'unselected' }] });
    resumed.subscriptions[0]!.update({ kind: 'status', state: 'live' });
    expect(resumed.publish.mock.lastCall?.[0].items).toEqual(previous.items);
    resumed.subscriptions[0]!.update({ kind: 'snapshot', items: [] });
    expect(resumed.publish.mock.lastCall?.[0].items.map((r: Resource) => r.metadata.name)).toEqual(['team-node', 'other-cluster']);
    resumed.stop();
  });
  it('streams each namespace, applies additions/modifications/deletions, and replaces snapshots on reconnect', () => {
    const { subscriptions, publish, stop } = fixture();
    expect(subscriptions.map((s) => [s.params.ctx, s.params.namespace])).toEqual([
      ['a', 'lab'],
      ['a', 'team'],
      ['b', undefined],
    ]);
    const update = subscriptions[0]!.update;
    update({ kind: 'snapshot', items: [item('first')] });
    update({
      kind: 'events',
      events: [
        { type: 'ADDED', object: item('second') },
        { type: 'MODIFIED', object: { ...item('first'), status: { readiness: 'ready' } } },
      ],
    });
    expect(publish.mock.lastCall?.[0].items).toEqual([
      expect.objectContaining({ ctx: 'a', plural: 'nodes', apiVersion: 'c9s.run/v1alpha1', status: { readiness: 'ready' } }),
      expect.objectContaining({ metadata: expect.objectContaining({ name: 'second' }) }),
    ]);
    update({ kind: 'events', events: [{ type: 'DELETED', object: item('first') }] });
    expect(publish.mock.lastCall?.[0].items).toHaveLength(1);
    update({ kind: 'snapshot', items: [item('replacement')] });
    expect(publish.mock.lastCall?.[0].items.map((r: Resource) => r.metadata.name)).toEqual(['replacement']);
    stop();
  });
  it('retains healthy data on errors, reports recovery, and ignores late messages after cleanup', () => {
    const { subscriptions, publish, stop } = fixture();
    subscriptions[0]!.update({ kind: 'snapshot', items: [item('healthy')] });
    subscriptions[1]!.update({ kind: 'snapshot', items: [] });
    subscriptions[2]!.update({ kind: 'status', state: 'error', message: 'Forbidden' });
    expect(publish.mock.lastCall).toEqual([
      expect.objectContaining({
        items: [expect.objectContaining({ ctx: 'a' })],
        errors: [expect.objectContaining({ ctx: 'b', message: 'Forbidden' })],
      }),
      false,
    ]);
    subscriptions[2]!.update({ kind: 'status', state: 'live' });
    expect(publish.mock.lastCall?.[0].errors).toEqual([]);
    stop();
    publish.mockClear();
    subscriptions[0]!.update({ kind: 'snapshot', items: [item('stale')] });
    expect(publish).not.toHaveBeenCalled();
    expect(subscriptions.every((s) => s.stop.mock.calls.length === 1)).toBe(true);
  });
});
