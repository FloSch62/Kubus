import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCrossWindowStateSync } from '../../../client/src/cross-window-state.js';
import { applyAppWindowContext, currentAppWindowContext } from '../../../client/src/window-context.js';
import { useClustersStore } from '../../../client/src/state/clusters.js';
import { useNavigationStore } from '../../../client/src/state/navigation.js';
import { useUiPrefsStore } from '../../../client/src/state/prefs.js';
import { skipUnchangedStorageWrites } from '../../../client/src/state/persist-storage.js';

function publishStorage(name: string, state: Record<string, unknown>): void {
  const value = JSON.stringify({ state, version: 0 });
  localStorage.setItem(name, value);
  window.dispatchEvent(new StorageEvent('storage', { key: name, newValue: value }));
}

beforeAll(() => installCrossWindowStateSync());

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useClustersStore.setState({
    selected: ['window-a'],
    namespaces: ['team-a'],
    themeMode: 'light',
    contextSettings: {},
    contextOrder: [],
    pickerLayout: 'list',
  });
  useUiPrefsStore.setState({ tableDensity: 'compact', navCollapsed: true });
  useNavigationStore.setState({ favorites: [], savedViews: [] });
});

describe('cross-window state boundaries', () => {
  it('rehydrates shared cluster metadata without replacing the local working context', async () => {
    publishStorage('kubus-clusters', {
      themeMode: 'dark',
      contextSettings: { prod: { protected: true } },
      contextOrder: ['prod'],
      pickerLayout: 'grid',
      // Legacy/hostile extra fields must still remain window-local.
      selected: ['window-b'],
      namespaces: ['team-b'],
    });

    await vi.waitFor(() => expect(useClustersStore.getState().themeMode).toBe('dark'));
    expect(useClustersStore.getState()).toMatchObject({
      selected: ['window-a'],
      namespaces: ['team-a'],
      contextSettings: { prod: { protected: true } },
      contextOrder: ['prod'],
      pickerLayout: 'grid',
    });
  });

  it('syncs durable UI preferences while preserving this window nav layout', async () => {
    publishStorage('kubus-prefs', {
      tableDensity: 'comfortable',
      navCollapsed: false,
    });

    await vi.waitFor(() => expect(useUiPrefsStore.getState().tableDensity).toBe('comfortable'));
    expect(useUiPrefsStore.getState().navCollapsed).toBe(true);
  });

  it('keeps saved definitions live across windows', async () => {
    publishStorage('kubus-navigation', {
      favorites: [{ id: 'pods', title: 'Pods' }],
      savedViews: [{ id: 'errors', title: 'Errors', path: '/events?q=error' }],
    });

    await vi.waitFor(() => expect(useNavigationStore.getState().favorites).toHaveLength(1));
    expect(useNavigationStore.getState().savedViews).toEqual([
      { id: 'errors', title: 'Errors', path: '/events?q=error' },
    ]);
  });

  it('copies launch context once and then allows the destination to diverge', () => {
    applyAppWindowContext({ selected: ['source'], namespaces: ['production'], navCollapsed: false });
    expect(currentAppWindowContext()).toEqual({
      selected: ['source'],
      namespaces: ['production'],
      namespacesByContext: { source: ['production'] },
      navCollapsed: false,
    });

    // Namespaces are remembered per cluster: the destination cluster has no
    // selection of its own yet, so the filter opens up to all namespaces.
    useClustersStore.getState().setSelected(['destination']);
    useUiPrefsStore.getState().set({ navCollapsed: true });
    expect(currentAppWindowContext()).toEqual({
      selected: ['destination'],
      namespaces: [],
      namespacesByContext: {},
      navCollapsed: true,
    });
    useClustersStore.getState().setSelected(['source']);
    expect(currentAppWindowContext().namespaces).toEqual(['production']);
  });

  it('carries each cluster its own namespaces into a new window instead of the union', () => {
    useClustersStore.setState({ selected: [], namespaces: [], namespacesByContext: {} });
    useClustersStore.getState().setSelected(['dev', 'prod']);
    useClustersStore.getState().setNamespaces(['team-a'], ['dev']);
    useClustersStore.getState().setNamespaces(['payments'], ['prod']);
    const context = currentAppWindowContext();
    expect([...context.namespaces].sort()).toEqual(['payments', 'team-a']);
    expect(context.namespacesByContext).toEqual({ dev: ['team-a'], prod: ['payments'] });

    useClustersStore.getState().setSelected([]);
    applyAppWindowContext(context);
    expect(useClustersStore.getState().namespacesByContext).toEqual({ dev: ['team-a'], prod: ['payments'] });
    useClustersStore.getState().setSelected(['prod']);
    expect(useClustersStore.getState().namespaces).toEqual(['payments']);

    // A snapshot from an older window only knows the union; every selected cluster gets it.
    applyAppWindowContext({ selected: ['dev', 'prod'], namespaces: ['shared'], navCollapsed: false });
    expect(useClustersStore.getState().namespacesByContext).toEqual({ dev: ['shared'], prod: ['shared'] });
  });

  it('does not persist window-local fields in app-wide store payloads', () => {
    useClustersStore.getState().setSelected(['private-window']);
    useUiPrefsStore.getState().set({ navCollapsed: false });

    const clusters = JSON.parse(localStorage.getItem('kubus-clusters') ?? '{}') as { state?: Record<string, unknown> };
    const prefs = JSON.parse(localStorage.getItem('kubus-prefs') ?? '{}') as { state?: Record<string, unknown> };
    expect(clusters.state).not.toHaveProperty('selected');
    expect(clusters.state).not.toHaveProperty('namespaces');
    expect(prefs.state).not.toHaveProperty('navCollapsed');
  });

  it('does not broadcast when a local-only action leaves shared data unchanged', () => {
    const setItem = vi.fn();
    const storage = skipUnchangedStorageWrites({
      getItem: () => 'same',
      setItem,
      removeItem: vi.fn(),
    });

    storage.setItem('shared', 'same');
    expect(setItem).not.toHaveBeenCalled();
    storage.setItem('shared', 'changed');
    expect(setItem).toHaveBeenCalledExactlyOnceWith('shared', 'changed');
  });
});
