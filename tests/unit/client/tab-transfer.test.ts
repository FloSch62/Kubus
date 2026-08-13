import { afterEach, describe, expect, it, vi } from 'vitest';

class TestBroadcastChannel {
  static readonly instances = new Set<TestBroadcastChannel>();
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  constructor(readonly name: string) {
    TestBroadcastChannel.instances.add(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  postMessage(data: unknown): void {
    for (const channel of TestBroadcastChannel.instances) {
      if (channel === this || channel.name !== this.name) continue;
      queueMicrotask(() => {
        for (const listener of channel.listeners) listener({ data } as MessageEvent);
      });
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestBroadcastChannel.instances.clear();
});

describe('cross-window Kubus tab transfer', () => {
  it('moves a page identity and removes the source only after destination adoption', async () => {
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    vi.resetModules();
    const source = await import('../../../client/src/tab-transfer.js');
    const sourceTabs = await import('../../../client/src/state/tabs.js');
    sourceTabs.useTabsStore.setState({
      tabs: [{ id: 'page-source', path: '/helm', customTitle: 'Releases', color: '#42a5f5' }],
      activeId: 'page-source',
      closedPaths: [],
    });
    source.registerTabTransferSource('page-transfer', 'page', 'page-source');

    vi.resetModules();
    const destination = await import('../../../client/src/tab-transfer.js');
    const destinationTabs = await import('../../../client/src/state/tabs.js');
    destinationTabs.useTabsStore.setState({
      tabs: [{ id: 'placeholder', path: '/' }],
      activeId: 'placeholder',
      closedPaths: [],
    });

    expect(await destination.receiveTabTransfer('page-transfer', undefined, 'after', true)).toBe(true);
    expect(destinationTabs.useTabsStore.getState().tabs).toEqual([
      { id: 'page-source', path: '/helm', customTitle: 'Releases', color: '#42a5f5' },
    ]);
    await vi.waitFor(() => expect(sourceTabs.useTabsStore.getState().tabs[0]?.path).toBe('/'));
  });

  it('keeps a live terminal source until the destination confirms server attachment', async () => {
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    vi.resetModules();
    const source = await import('../../../client/src/tab-transfer.js');
    const sourceDock = await import('../../../client/src/state/dock.js');
    const sourceRegistry = await import('../../../client/src/terminal-registry.js');
    const prepare = vi.fn(async () => true);
    const cancel = vi.fn();
    sourceDock.useDockStore.setState({
      tabs: [{
        kind: 'terminal',
        id: 'terminal-source',
        title: 'sh: api-0',
        ctx: 'dev',
        namespace: 'default',
        pod: 'api-0',
        container: 'app',
        terminalId: 'terminal-live',
      }],
      activeId: 'terminal-source',
      open: true,
    });
    sourceRegistry.registerTerminal('terminal-source', {
      prepareTransfer: prepare,
      cancelTransfer: cancel,
      snapshot: () => '\u001b[32mhistory\u001b[0m',
    });
    source.registerTabTransferSource('terminal-transfer', 'dock', 'terminal-source');

    vi.resetModules();
    const destination = await import('../../../client/src/tab-transfer.js');
    const destinationDock = await import('../../../client/src/state/dock.js');
    destinationDock.useDockStore.setState({ tabs: [], activeId: undefined, open: false });

    expect(await destination.receiveTabTransfer('terminal-transfer')).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(destinationDock.useDockStore.getState().tabs[0]).toMatchObject({
      id: 'terminal-source',
      terminalId: 'terminal-live',
      transferId: 'terminal-transfer',
      snapshot: '\u001b[32mhistory\u001b[0m',
    });
    expect(sourceDock.useDockStore.getState().tabs).toHaveLength(1);

    destination.completeTabTransfer('terminal-transfer');
    await vi.waitFor(() => expect(sourceDock.useDockStore.getState().tabs).toHaveLength(0));
    expect(cancel).not.toHaveBeenCalled();
  });
});
