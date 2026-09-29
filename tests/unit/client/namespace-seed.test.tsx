import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kubeconfigNamespaceSeed, useClustersStore } from '../../../client/src/state/clusters';
import { ClusterSwitcher } from '../../../client/src/layout/ClusterSwitcher';

const queryMocks = vi.hoisted(() => ({
  contexts: [] as Array<Record<string, unknown>>,
  connect: { mutate: vi.fn(), isPending: false, variables: undefined as unknown },
  reconnect: { mutate: vi.fn(), isPending: false, variables: undefined as unknown },
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useContexts: () => ({ data: queryMocks.contexts }),
  useConnectContext: () => queryMocks.connect,
  useReconnectContext: () => queryMocks.reconnect,
}));

vi.mock('../../../client/src/api/ws/watch-client.js', () => ({
  watchClient: { onContextIssues: () => vi.fn() },
}));

describe('kubeconfigNamespaceSeed', () => {
  const contexts = [
    { name: 'dev', namespace: 'team-a' },
    { name: 'prod', namespace: 'payments' },
    { name: 'lab' },
  ];

  it('seeds a newly selected context from its kubeconfig namespace', () => {
    const seed = kubeconfigNamespaceSeed({ selected: ['dev'], namespaceSeeded: [], namespacesByContext: {} }, contexts);
    expect(seed).toEqual({ namespaceSeeded: ['dev'], namespacesByContext: { dev: ['team-a'] } });
  });

  it('marks contexts without a namespace as seeded without adding a filter', () => {
    const seed = kubeconfigNamespaceSeed({ selected: ['lab'], namespaceSeeded: [], namespacesByContext: {} }, contexts);
    expect(seed).toEqual({ namespaceSeeded: ['lab'], namespacesByContext: {} });
  });

  it('never overrides a filter the cluster already has', () => {
    const seed = kubeconfigNamespaceSeed({ selected: ['dev'], namespaceSeeded: [], namespacesByContext: { dev: ['team-b'] } }, contexts);
    expect(seed?.namespacesByContext).toEqual({ dev: ['team-b'] });
    expect(seed?.namespaceSeeded).toEqual(['dev']);
  });

  it('seeds each context only once, and only when selected', () => {
    expect(kubeconfigNamespaceSeed({ selected: ['dev'], namespaceSeeded: ['dev'], namespacesByContext: {} }, contexts)).toBeUndefined();
    expect(kubeconfigNamespaceSeed({ selected: [], namespaceSeeded: [], namespacesByContext: {} }, contexts)).toBeUndefined();
  });
});

describe('useClustersStore.seedKubeconfigNamespaces', () => {
  beforeEach(() => {
    useClustersStore.setState({ selected: ['dev', 'prod'], namespaces: [], namespacesByContext: {}, namespaceSeeded: ['prod'] });
  });

  it('applies the seed and recomputes the effective filter', () => {
    useClustersStore.getState().seedKubeconfigNamespaces([
      { name: 'dev', namespace: 'team-a' },
      { name: 'prod', namespace: 'payments' },
    ]);
    const state = useClustersStore.getState();
    expect(state.namespacesByContext).toEqual({ dev: ['team-a'] });
    expect(state.namespaces).toEqual(['team-a']);
    expect(state.namespaceSeeded).toEqual(['prod', 'dev']);
  });

  it('lets the user clear a seeded filter for good', () => {
    const { seedKubeconfigNamespaces } = useClustersStore.getState();
    seedKubeconfigNamespaces([{ name: 'dev', namespace: 'team-a' }]);
    useClustersStore.getState().setNamespaces([], ['dev']);
    seedKubeconfigNamespaces([{ name: 'dev', namespace: 'team-a' }]);
    expect(useClustersStore.getState().namespaces).toEqual([]);
  });

  it('forgets the seed when the context is removed', () => {
    useClustersStore.getState().removeContext('prod');
    expect(useClustersStore.getState().namespaceSeeded).toEqual([]);
  });
});

describe('seed persistence', () => {
  it('treats the open clusters of state saved before seeding existed as already seeded', async () => {
    // Every setState persists, so write the legacy snapshot afterwards.
    useClustersStore.setState({ selected: ['dev'], namespaceSeeded: [] });
    localStorage.setItem('kubus-clusters', JSON.stringify({ state: { themeMode: 'dark', contextSettings: {} }, version: 0 }));
    await useClustersStore.persist.rehydrate();
    expect(useClustersStore.getState().namespaceSeeded).toEqual(['dev']);

    localStorage.setItem('kubus-clusters', JSON.stringify({ state: { themeMode: 'dark', namespaceSeeded: ['prod'] }, version: 0 }));
    await useClustersStore.persist.rehydrate();
    expect(useClustersStore.getState().namespaceSeeded).toEqual(['prod']);
    localStorage.removeItem('kubus-clusters');
  });
});

describe('ClusterSwitcher first launch', () => {
  beforeEach(() => {
    queryMocks.connect.mutate.mockClear();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useClustersStore.setState({ selected: [], namespaces: [], namespacesByContext: {}, namespaceSeeded: [], contextSettings: {}, contextOrder: [] });
  });

  it('selects the current context and starts on its kubeconfig namespace', async () => {
    queryMocks.contexts = [
      { name: 'dev', cluster: 'dev', namespace: 'team-a', current: true, active: false, health: 'unknown' },
      { name: 'prod', cluster: 'prod', namespace: 'payments', current: false, active: false, health: 'unknown' },
    ];
    render(<ClusterSwitcher />);
    await waitFor(() => expect(useClustersStore.getState().selected).toEqual(['dev']));
    await waitFor(() => expect(useClustersStore.getState().namespaces).toEqual(['team-a']));
    expect(useClustersStore.getState().namespacesByContext).toEqual({ dev: ['team-a'] });

    // Selecting prod later seeds it too; dev keeps what it has.
    useClustersStore.getState().toggleContext('prod');
    await waitFor(() => expect(useClustersStore.getState().namespacesByContext).toEqual({ dev: ['team-a'], prod: ['payments'] }));
    expect(useClustersStore.getState().namespaces).toEqual(['team-a', 'payments']);
  });
});
