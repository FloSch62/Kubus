import { beforeEach, describe, expect, it } from 'vitest';
import type { ResourceRef } from '@kubus/shared';
import { RECENT_LIMIT, resourceResultId, useRecentStore } from '../../../client/src/state/recent';

const ref = (name: string, ctx = 'kind-a'): ResourceRef => ({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name, namespace: 'demo' });

beforeEach(() => {
  useRecentStore.setState({ recent: [] });
});

describe('recent resources', () => {
  it('uses the search-result id format so favorites and recents dedupe', () => {
    expect(resourceResultId(ref('web'))).toBe('resource:kind-a:/v1/pods:demo:web');
  });

  it('keeps the newest open first without duplicates', () => {
    const { record } = useRecentStore.getState();
    record(ref('a'));
    record(ref('b'));
    record(ref('a'));
    expect(useRecentStore.getState().recent.map((r) => r.ref.name)).toEqual(['a', 'b']);
  });

  it('forgets the oldest past the limit', () => {
    const { record } = useRecentStore.getState();
    for (let i = 0; i < RECENT_LIMIT + 3; i++) record(ref(`p${i}`));
    const names = useRecentStore.getState().recent.map((r) => r.ref.name);
    expect(names).toHaveLength(RECENT_LIMIT);
    expect(names[0]).toBe(`p${RECENT_LIMIT + 2}`);
  });

  it('tells the same name in two clusters apart', () => {
    const { record } = useRecentStore.getState();
    record(ref('web', 'a'));
    record(ref('web', 'b'));
    expect(useRecentStore.getState().recent).toHaveLength(2);
  });
});
