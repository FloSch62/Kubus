import { beforeEach, describe, expect, it, vi } from 'vitest';

type IpcListener = (event: unknown, ...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<IpcListener>>();
  const ipcRenderer = {
    sendSync: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn(),
    on: vi.fn((channel: string, listener: IpcListener) => {
      const channelListeners = listeners.get(channel) ?? new Set<IpcListener>();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return ipcRenderer;
    }),
    removeListener: vi.fn((channel: string, listener: IpcListener) => {
      listeners.get(channel)?.delete(listener);
      return ipcRenderer;
    }),
  };
  const exposeInMainWorld = vi.fn();

  return {
    contextBridge: { exposeInMainWorld },
    exposeInMainWorld,
    ipcRenderer,
    listeners,
    emit(channel: string, ...args: unknown[]) {
      for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
}));

interface DesktopBridge {
  platform: string;
  stateStorage: {
    getItem(name: string): string | null;
    setItem(name: string, value: string): void;
    removeItem(name: string): void;
  };
  setTitleBarOverlay(options: { color: string; symbolColor: string }): void;
  getAppInfo(): Promise<unknown>;
  checkForUpdate(options?: { force?: boolean }): Promise<unknown>;
  onCloseTab(callback: () => void): () => void;
  onCycleTab(callback: (backwards: boolean) => void): () => void;
  onOpenRoute(callback: (route: string) => void): () => void;
  getPendingRoute(): Promise<string | null>;
  closeWindow(): void;
}

async function loadBridge(snapshot: unknown = {}): Promise<DesktopBridge> {
  if (snapshot instanceof Error) {
    electron.ipcRenderer.sendSync.mockImplementation(() => {
      throw snapshot;
    });
  } else {
    electron.ipcRenderer.sendSync.mockReturnValue(snapshot);
  }
  await import('../../../electron/src/preload.js');
  expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
  expect(electron.exposeInMainWorld.mock.calls[0]?.[0]).toBe('kubusDesktop');
  return electron.exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;
}

beforeEach(() => {
  vi.resetModules();
  electron.listeners.clear();
  electron.exposeInMainWorld.mockClear();
  electron.ipcRenderer.sendSync.mockReset();
  electron.ipcRenderer.send.mockClear();
  electron.ipcRenderer.invoke.mockReset();
  electron.ipcRenderer.on.mockClear();
  electron.ipcRenderer.removeListener.mockClear();
  vi.unstubAllGlobals();
});

describe('Electron preload bridge', () => {
  it('serves a boot snapshot and mirrors state mutations over asynchronous IPC', async () => {
    const bridge = await loadBridge({ theme: 'dark', tabs: 'one' });

    expect(electron.ipcRenderer.sendSync).toHaveBeenCalledWith('kubus:state:get-all');
    expect(bridge.platform).toBe(process.platform);
    expect(bridge.stateStorage.getItem('theme')).toBe('dark');
    expect(bridge.stateStorage.getItem('missing')).toBeNull();

    bridge.stateStorage.setItem('theme', 'light');
    expect(bridge.stateStorage.getItem('theme')).toBe('light');
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('kubus:state:set-item', 'theme', 'light');

    bridge.stateStorage.removeItem('tabs');
    expect(bridge.stateStorage.getItem('tabs')).toBeNull();
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('kubus:state:remove-item', 'tabs');
  });

  it('exposes only typed native commands and forwards their arguments', async () => {
    electron.ipcRenderer.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'kubus:get-app-info') return { name: 'Kubus' };
      if (channel === 'kubus:get-pending-route') return '/pending';
      return { available: false };
    });
    const bridge = await loadBridge();

    bridge.setTitleBarOverlay({ color: '#111111', symbolColor: '#eeeeee' });
    bridge.closeWindow();
    await expect(bridge.getAppInfo()).resolves.toEqual({ name: 'Kubus' });
    await expect(bridge.checkForUpdate({ force: true })).resolves.toEqual({ available: false });
    await expect(bridge.getPendingRoute()).resolves.toBe('/pending');

    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('kubus:set-titlebar-overlay', {
      color: '#111111',
      symbolColor: '#eeeeee',
    });
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('kubus:close-window');
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('kubus:get-app-info');
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('kubus:check-for-update', { force: true });
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('kubus:get-pending-route');
  });

  it('normalizes event payloads and removes the exact listeners on unsubscribe', async () => {
    const bridge = await loadBridge();
    const close = vi.fn();
    const cycle = vi.fn();
    const route = vi.fn();

    const offClose = bridge.onCloseTab(close);
    const offCycle = bridge.onCycleTab(cycle);
    const offRoute = bridge.onOpenRoute(route);

    electron.emit('kubus:close-tab');
    electron.emit('kubus:cycle-tab', true);
    electron.emit('kubus:cycle-tab', 'true');
    electron.emit('kubus:open-route', '/r/core/v1/pods');
    electron.emit('kubus:open-route', { path: '/unsafe' });

    expect(close).toHaveBeenCalledOnce();
    expect(cycle.mock.calls).toEqual([[true], [false]]);
    expect(route).toHaveBeenCalledExactlyOnceWith('/r/core/v1/pods');

    offClose();
    offCycle();
    offRoute();
    electron.emit('kubus:close-tab');
    electron.emit('kubus:cycle-tab', false);
    electron.emit('kubus:open-route', '/after-unsubscribe');

    expect(close).toHaveBeenCalledOnce();
    expect(cycle).toHaveBeenCalledTimes(2);
    expect(route).toHaveBeenCalledOnce();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledTimes(3);
  });

  it('falls back safely when the boot snapshot fails and preserves state in localStorage after a disk error', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('window', { localStorage: { setItem } });

    const bridge = await loadBridge(new Error('main process unavailable'));
    expect(bridge.stateStorage.getItem('missing')).toBeNull();

    bridge.stateStorage.setItem('theme', 'dark');
    bridge.stateStorage.setItem('tabs', 'serialized');
    electron.emit('kubus:state:write-failed');

    expect(setItem.mock.calls).toEqual([
      ['theme', 'dark'],
      ['tabs', 'serialized'],
    ]);
  });
});
