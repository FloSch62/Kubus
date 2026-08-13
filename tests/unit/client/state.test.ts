import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampDetailWidth } from '../../../client/src/state/detail';
import { clampDockHeight, useDockStore, type DockTab, type TerminalTab } from '../../../client/src/state/dock';
import { forwardPrefKey } from '../../../client/src/state/portforward-prefs';
import { errorDetails } from '../../../client/src/state/toast';
import { namespaceVisible } from '../../../client/src/state/clusters';
import { useNavigationStore } from '../../../client/src/state/navigation';
import { useTabsStore, type PageTab } from '../../../client/src/state/tabs';

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
}

describe('clampDetailWidth', () => {
  beforeEach(() => setViewport(1000, 800));

  it('clamps between 380 and 70% of the window width', () => {
    expect(clampDetailWidth(100)).toBe(380);
    expect(clampDetailWidth(380)).toBe(380);
    expect(clampDetailWidth(500)).toBe(500);
    expect(clampDetailWidth(5000)).toBe(700);
  });

  it('follows the current window width', () => {
    setViewport(2000, 800);
    expect(clampDetailWidth(5000)).toBe(1400);
  });
});

describe('clampDockHeight', () => {
  beforeEach(() => setViewport(1000, 800));

  it('clamps between 160 and window height minus 200', () => {
    expect(clampDockHeight(10)).toBe(160);
    expect(clampDockHeight(300)).toBe(300);
    expect(clampDockHeight(9999)).toBe(600);
  });
});

describe('useDockStore terminal focus requests', () => {
  const terminal: DockTab = {
    kind: 'terminal',
    id: 'terminal',
    title: 'shell',
    ctx: 'kind-a',
    namespace: 'default',
    pod: 'web',
    container: 'web',
  };
  const logs: DockTab = {
    kind: 'logs',
    id: 'logs',
    title: 'logs',
    ctx: 'kind-a',
    namespace: 'default',
    pods: ['web'],
  };

  beforeEach(() => {
    useDockStore.setState({
      tabs: [terminal, logs],
      activeId: logs.id,
      open: false,
      maximized: false,
      terminalFocusRequest: undefined,
      terminalReconnectRequests: {},
    });
  });

  it('opens, activates, and issues a fresh request for an existing terminal', () => {
    useDockStore.getState().requestTerminalFocus(terminal.id);
    const first = useDockStore.getState();
    expect(first.open).toBe(true);
    expect(first.activeId).toBe(terminal.id);
    expect(first.terminalFocusRequest).toEqual({ tabId: terminal.id, sequence: 1 });

    first.setOpen(false);
    useDockStore.getState().requestTerminalFocus(terminal.id);
    expect(useDockStore.getState().terminalFocusRequest).toEqual({ tabId: terminal.id, sequence: 2 });
  });

  it('ignores log tabs and unknown ids for focus requests', () => {
    const before = useDockStore.getState();
    before.requestTerminalFocus(logs.id);
    before.requestTerminalFocus('missing');
    expect(useDockStore.getState()).toBe(before);
  });

  it('issues reconnect requests without activating or opening the terminal', () => {
    useDockStore.getState().requestTerminalReconnect(terminal.id);
    useDockStore.getState().requestTerminalReconnect(terminal.id);

    const state = useDockStore.getState();
    expect(state.terminalReconnectRequests).toEqual({ [terminal.id]: 2 });
    expect(state.activeId).toBe(logs.id);
    expect(state.open).toBe(false);
  });

  it('ignores non-terminal reconnect requests and clears requests when a tab closes', () => {
    const before = useDockStore.getState();
    before.requestTerminalReconnect(logs.id);
    before.requestTerminalReconnect('missing');
    expect(useDockStore.getState()).toBe(before);

    before.requestTerminalReconnect(terminal.id);
    useDockStore.getState().closeTab(terminal.id);
    expect(useDockStore.getState().terminalReconnectRequests).toEqual({});
  });
});

describe('useDockStore tab quality-of-life actions', () => {
  const terminal = (id: string, pinned = false): TerminalTab => ({
    kind: 'terminal',
    id,
    title: id,
    ctx: 'kind-a',
    namespace: 'default',
    pod: id,
    container: 'app',
    pinned: pinned || undefined,
  });

  beforeEach(() => {
    useDockStore.setState({
      tabs: [terminal('pinned', true), terminal('a'), terminal('b'), terminal('c')],
      activeId: 'b',
      open: true,
      terminalReconnectRequests: {},
    });
  });

  it('renames, flags, pins, and keeps the pinned partition stable', () => {
    const store = useDockStore.getState();
    store.renameTab('b', '  API shell  ');
    store.setColor('b', '#42a5f5');
    store.setPinned('b', true);
    expect(useDockStore.getState().tabs.map((tab) => [tab.id, tab.title, tab.pinned, tab.color])).toEqual([
      ['pinned', 'pinned', true, undefined],
      ['b', 'API shell', true, '#42a5f5'],
      ['a', 'a', undefined, undefined],
      ['c', 'c', undefined, undefined],
    ]);

    useDockStore.getState().moveTab(1, 2);
    expect(useDockStore.getState().tabs.map((tab) => tab.id)).toEqual(['pinned', 'b', 'a', 'c']);
  });

  it('duplicates as a fresh session and strips server handoff state', () => {
    useDockStore.setState({
      tabs: [{ ...terminal('live'), terminalId: 'terminal-1', transferId: 'transfer-1', snapshot: 'history', color: '#f00' }],
      activeId: 'live',
    });
    useDockStore.getState().duplicateTab('live');
    const copy = useDockStore.getState().tabs[1];
    expect(copy).toMatchObject({ kind: 'terminal', title: 'live', color: '#f00' });
    expect(copy?.id).not.toBe('live');
    expect(copy).not.toHaveProperty('terminalId');
    expect(copy).not.toHaveProperty('transferId');
    expect(copy).not.toHaveProperty('snapshot');
  });

  it('close-other and close-right preserve pinned tabs', () => {
    useDockStore.getState().closeOthers('b');
    expect(useDockStore.getState().tabs.map((tab) => tab.id)).toEqual(['pinned', 'b']);

    useDockStore.setState({ tabs: [terminal('pinned', true), terminal('a'), terminal('b'), terminal('c')], activeId: 'c' });
    useDockStore.getState().closeRight('a');
    expect(useDockStore.getState().tabs.map((tab) => tab.id)).toEqual(['pinned', 'a']);
    expect(useDockStore.getState().activeId).toBe('a');
  });
});

describe('forwardPrefKey', () => {
  it('builds a stable per-target key', () => {
    expect(forwardPrefKey('kind-a', 'default', 'Service', 'web', 8080)).toBe('kind-a/default/Service/web:8080');
  });

  it('distinguishes remote ports on the same target', () => {
    expect(forwardPrefKey('c', 'ns', 'Pod', 'p', 80)).not.toBe(forwardPrefKey('c', 'ns', 'Pod', 'p', 443));
  });
});

describe('errorDetails', () => {
  it('returns undefined for non-Error values', () => {
    expect(errorDetails('boom')).toBeUndefined();
    expect(errorDetails(undefined)).toBeUndefined();
    expect(errorDetails({ message: 'x' })).toBeUndefined();
  });

  it('includes HTTP status and pretty-printed body for ApiError-shaped errors', () => {
    const err = Object.assign(new Error('server exploded'), { status: 500, body: { message: 'server exploded', code: 'E1' } });
    expect(errorDetails(err)).toBe(`HTTP 500\n${JSON.stringify({ message: 'server exploded', code: 'E1' }, null, 2)}`);
  });

  it('omits a zero status (network failure) and falls back to the stack', () => {
    const err = Object.assign(new Error('down'), { status: 0 });
    expect(errorDetails(err)).toBe(err.stack);
  });

  it('returns undefined when there is nothing beyond the message', () => {
    const err = new Error('plain');
    err.stack = '';
    expect(errorDetails(err)).toBeUndefined();
  });

  it('returns undefined when the details equal the message', () => {
    const err = new Error('same');
    err.stack = 'same';
    expect(errorDetails(err)).toBeUndefined();
  });
});

describe('namespaceVisible', () => {
  it('shows everything when the selection is empty', () => {
    expect(namespaceVisible('kube-system', [])).toBe(true);
    expect(namespaceVisible(undefined, [])).toBe(true);
  });

  it('always shows cluster-scoped items', () => {
    expect(namespaceVisible(undefined, ['default'])).toBe(true);
    expect(namespaceVisible('', ['default'])).toBe(true);
  });

  it('filters namespaced items by the selection', () => {
    expect(namespaceVisible('default', ['default', 'dev'])).toBe(true);
    expect(namespaceVisible('prod', ['default', 'dev'])).toBe(false);
  });
});

describe('useNavigationStore', () => {
  beforeEach(() => {
    useNavigationStore.setState({ favorites: [], savedViews: [] });
    localStorage.clear();
  });

  it('adds favorites at the front, replaces duplicates, and reports membership', () => {
    useNavigationStore.getState().addFavorite({ id: 'pods', title: 'Pods', path: '/pods' });
    useNavigationStore.getState().addFavorite({ id: 'deployments', title: 'Deployments', path: '/deployments' });
    useNavigationStore.getState().addFavorite({ id: 'pods', title: 'All Pods', path: '/pods?all=true' });

    expect(useNavigationStore.getState().favorites).toEqual([
      { id: 'pods', title: 'All Pods', path: '/pods?all=true' },
      { id: 'deployments', title: 'Deployments', path: '/deployments' },
    ]);
    expect(useNavigationStore.getState().isFavorite('pods')).toBe(true);
    expect(useNavigationStore.getState().isFavorite('services')).toBe(false);
  });

  it('moves favorites before and after another entry', () => {
    for (const id of ['a', 'b', 'c']) useNavigationStore.getState().addFavorite({ id, title: id });
    expect(useNavigationStore.getState().favorites.map((item) => item.id)).toEqual(['c', 'b', 'a']);

    useNavigationStore.getState().moveFavorite('a', 'c', 'before');
    expect(useNavigationStore.getState().favorites.map((item) => item.id)).toEqual(['a', 'c', 'b']);

    useNavigationStore.getState().moveFavorite('a', 'b', 'after');
    expect(useNavigationStore.getState().favorites.map((item) => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('ignores invalid favorite moves and removes entries', () => {
    useNavigationStore.getState().addFavorite({ id: 'a', title: 'A' });
    const before = useNavigationStore.getState();
    useNavigationStore.getState().moveFavorite('a', 'a', 'before');
    expect(useNavigationStore.getState()).toBe(before);

    useNavigationStore.getState().moveFavorite('missing', 'a', 'before');
    useNavigationStore.getState().moveFavorite('a', 'missing', 'after');
    expect(useNavigationStore.getState().favorites.map((item) => item.id)).toEqual(['a']);

    useNavigationStore.getState().removeFavorite('a');
    expect(useNavigationStore.getState().favorites).toEqual([]);
  });

  it('bounds favorites and saved views while replacing duplicate ids', () => {
    for (let i = 0; i < 45; i += 1) {
      useNavigationStore.getState().addFavorite({ id: `f${i}`, title: `Favorite ${i}` });
    }
    expect(useNavigationStore.getState().favorites).toHaveLength(40);
    expect(useNavigationStore.getState().favorites[0]?.id).toBe('f44');

    for (let i = 0; i < 35; i += 1) {
      useNavigationStore.getState().addSavedView({ id: `v${i}`, title: `View ${i}`, path: `/view/${i}` });
    }
    useNavigationStore.getState().addSavedView({ id: 'v34', title: 'Updated', path: '/updated' });
    expect(useNavigationStore.getState().savedViews).toHaveLength(30);
    expect(useNavigationStore.getState().savedViews[0]).toEqual({ id: 'v34', title: 'Updated', path: '/updated' });

    useNavigationStore.getState().removeSavedView('v34');
    expect(useNavigationStore.getState().savedViews.some((view) => view.id === 'v34')).toBe(false);
  });
});

describe('useTabsStore', () => {
  function seed(paths: string[], activeIdx = 0): PageTab[] {
    const tabs = paths.map((path, i) => ({ id: `t${i}`, path }));
    useTabsStore.setState({ tabs, activeId: tabs[activeIdx]!.id, closedPaths: [] });
    return tabs;
  }

  afterEach(() => {
    localStorage.clear();
  });

  it('starts with a single root tab', () => {
    // The store was created at import time, before any seeding.
    seed(['/']);
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0]!.id);
  });

  it('openTab appends and activates a new tab', () => {
    seed(['/a']);
    useTabsStore.getState().openTab('/b');
    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(['/a', '/b']);
    expect(s.activeId).toBe(s.tabs[1]!.id);
  });

  it('openTab with activate:false keeps the current tab active', () => {
    seed(['/a']);
    useTabsStore.getState().openTab('/b', { activate: false });
    expect(useTabsStore.getState().activeId).toBe('t0');
  });

  it('openTab with afterActive inserts next to the active tab', () => {
    seed(['/a', '/b', '/c'], 0);
    useTabsStore.getState().openTab('/x', { afterActive: true });
    expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(['/a', '/x', '/b', '/c']);
  });

  it('keeps new and reopened tabs behind the pinned group', () => {
    const tabs = seed(['/pinned-a', '/pinned-b', '/ordinary'], 0);
    useTabsStore.setState({
      tabs: tabs.map((tab, index) => ({ ...tab, pinned: index < 2 || undefined })),
      closedPaths: ['/closed'],
    });

    useTabsStore.getState().openTab('/new', { afterActive: true });
    expect(useTabsStore.getState().tabs.map((tab) => tab.path)).toEqual([
      '/pinned-a',
      '/pinned-b',
      '/new',
      '/ordinary',
    ]);

    useTabsStore.getState().setActive('t0');
    useTabsStore.getState().reopenTab();
    expect(useTabsStore.getState().tabs.map((tab) => tab.path)).toEqual([
      '/pinned-a',
      '/pinned-b',
      '/closed',
      '/new',
      '/ordinary',
    ]);
  });

  it('closing the active tab activates its right neighbor and records the path', () => {
    seed(['/a', '/b', '/c'], 1);
    useTabsStore.getState().closeTab('t1');
    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(['/a', '/c']);
    expect(s.activeId).toBe('t2');
    expect(s.closedPaths).toEqual(['/b']);
  });

  it('closing an inactive tab keeps the active one', () => {
    seed(['/a', '/b'], 0);
    useTabsStore.getState().closeTab('t1');
    expect(useTabsStore.getState().activeId).toBe('t0');
  });

  it('closing the last tab resets to a fresh root tab', () => {
    seed(['/only']);
    useTabsStore.getState().closeTab('t0');
    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.path).toBe('/');
    expect(s.activeId).toBe(s.tabs[0]!.id);
    expect(s.closedPaths).toEqual(['/only']);
  });

  it('reopenTab restores the most recently closed path next to the active tab', () => {
    seed(['/a', '/b'], 0);
    useTabsStore.getState().closeTab('t1');
    useTabsStore.getState().reopenTab();
    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(['/a', '/b']);
    expect(s.activeId).toBe(s.tabs[1]!.id);
    expect(s.closedPaths).toEqual([]);
  });

  it('reopenTab is a no-op with nothing closed', () => {
    seed(['/a']);
    const before = useTabsStore.getState();
    useTabsStore.getState().reopenTab();
    expect(useTabsStore.getState()).toBe(before);
  });

  it('closeOthers keeps only the given tab and records the rest', () => {
    seed(['/a', '/b', '/c'], 0);
    useTabsStore.getState().closeOthers('t1');
    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(['/b']);
    expect(s.activeId).toBe('t1');
    expect(s.closedPaths).toEqual(['/a', '/c']);
  });

  it('closeRight drops tabs after the given one and fixes the active id', () => {
    seed(['/a', '/b', '/c'], 2);
    useTabsStore.getState().closeRight('t0');
    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(['/a']);
    expect(s.activeId).toBe('t0');
    expect(s.closedPaths).toEqual(['/b', '/c']);
  });

  it('moveTab reorders and ignores out-of-range indices', () => {
    seed(['/a', '/b', '/c']);
    useTabsStore.getState().moveTab(0, 2);
    expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(['/b', '/c', '/a']);
    const before = useTabsStore.getState();
    useTabsStore.getState().moveTab(0, 5);
    expect(useTabsStore.getState()).toBe(before);
  });

  it('renames, flags, pins, duplicates, and preserves pinned tabs during bulk close', () => {
    seed(['/a', '/b', '/c']);
    useTabsStore.getState().renameTab('t1', '  Workloads  ');
    useTabsStore.getState().setColor('t1', '#42a5f5');
    useTabsStore.getState().setPinned('t0', true);
    useTabsStore.getState().duplicateTab('t1');
    let state = useTabsStore.getState();
    expect(state.tabs[0]).toMatchObject({ id: 't0', pinned: true });
    expect(state.tabs.find((tab) => tab.id === 't1')).toMatchObject({ customTitle: 'Workloads', color: '#42a5f5' });
    expect(state.tabs[2]).toMatchObject({ path: '/b', customTitle: 'Workloads', color: '#42a5f5' });
    expect(state.tabs[2]).not.toHaveProperty('pinned');

    useTabsStore.getState().closeOthers('t1');
    state = useTabsStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(['t0', 't1']);
  });

  it('adopts an existing cross-window identity at the requested edge', () => {
    seed(['/a', '/b']);
    expect(useTabsStore.getState().adoptTab({ id: 'remote', path: '/helm' }, 't1', 'before')).toBe(true);
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual(['t0', 'remote', 't1']);
    expect(useTabsStore.getState().activeId).toBe('remote');
    expect(useTabsStore.getState().adoptTab({ id: 'remote', path: '/again' })).toBe(false);
  });

  it('syncLocation mirrors the router path into the active tab', () => {
    seed(['/a', '/b'], 1);
    useTabsStore.getState().syncLocation('/b?q=web');
    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(['/a', '/b?q=web']);
    expect(s.activeId).toBe('t1');
  });

  it('syncLocation with an unchanged path does not produce a new state', () => {
    seed(['/a'], 0);
    const before = useTabsStore.getState();
    useTabsStore.getState().syncLocation('/a');
    expect(useTabsStore.getState()).toBe(before);
  });
});
