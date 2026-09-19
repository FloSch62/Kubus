import { describe, expect, it, vi } from 'vitest';
import { readCollections } from '../../../plugins/clabernetes/src/data.js';
import { PluginError, type PluginClient, type PluginContext } from '../../../plugins/sdk/src/index.js';

const context: PluginContext = {
  contexts: ['a', 'b'],
  namespacesByContext: { a: ['lab', 'team'] },
  active: true,
  theme: 'light',
  refreshInterval: 10000,
};
describe('c9s collection reads', () => {
  it('paginates each namespace and retains healthy clusters when another is forbidden', async () => {
    const list = vi.fn(async (query) => {
      if (query.ctx === 'b') throw new PluginError('Forbidden', 403);
      return {
        items: [{ metadata: { name: query.continue ? 'second' : 'first', namespace: query.namespace } }],
        continue: query.continue ? undefined : 'page-2',
      };
    });
    const snapshot = await readCollections(
      { list } as unknown as PluginClient,
      context,
      [{ group: 'c9s.run', plural: 'topologies' }],
      () => false,
    );
    expect(snapshot.items).toHaveLength(4);
    expect(new Set(snapshot.items.map((r) => r.metadata.namespace))).toEqual(new Set(['lab', 'team']));
    expect(snapshot.items.every((r) => r.ctx === 'a')).toBe(true);
    expect(snapshot.errors).toEqual([expect.objectContaining({ ctx: 'b', status: 403 })]);
    expect(list.mock.calls.filter(([q]) => q.ctx === 'a').every(([q]) => !!q.namespace)).toBe(true);
  });
  it('discards a response completed after switching away and stops pagination', async () => {
    let cancelled = false;
    const list = vi.fn(async () => {
      cancelled = true;
      return { items: [{ metadata: { name: 'stale' } }], continue: 'more' };
    });
    const snapshot = await readCollections(
      { list } as unknown as PluginClient,
      { ...context, contexts: ['a'], namespacesByContext: {} },
      [{ group: 'c9s.run', plural: 'nodes' }],
      () => cancelled,
    );
    expect(snapshot.items).toEqual([]);
    expect(list).toHaveBeenCalledOnce();
  });
});
