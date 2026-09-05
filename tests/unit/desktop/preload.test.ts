// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

const transport = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => void>,
  request: {
    bootstrap: vi.fn(async () => ({ platform: 'linux', state: { theme: 'dark' }, launch: undefined })),
    getAppInfo: vi.fn(async () => ({ name: 'Kubus', version: '0.9.0', helmEngine: true })),
    checkForUpdate: vi.fn(async () => ({ available: false, currentVersion: '0.9.0' })),
    getPendingRoute: vi.fn(async () => '/pods'),
    detachTab: vi.fn(async () => true),
  },
  send: Object.fromEntries(['windowAction', 'stateChanged', 'openWindow', 'closeWindow', 'minimizeWindow', 'toggleMaximize', 'openExternal'].map((name) => [name, vi.fn()])),
}));
vi.mock('electrobun/view', () => ({ Electroview: class {
  static defineRPC({ handlers }: any) { transport.handlers = handlers.messages; return transport; }
} }));
let documentEvents: MockInstance<Document['addEventListener']>;
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); delete window.kubusDesktop; delete window.kubusDesktopReady; vi.spyOn(window, 'addEventListener'); documentEvents = vi.spyOn(document, 'addEventListener'); });
afterEach(() => {
  for (const [name, callback, options] of vi.mocked(window.addEventListener).mock.calls) window.removeEventListener(name, callback, options);
  for (const [name, callback, options] of documentEvents.mock.calls) document.removeEventListener(name, callback, options);
  vi.restoreAllMocks(); document.body.innerHTML = ''; delete window.kubusDesktop; delete window.kubusDesktopReady;
});

it('hydrates before the SPA, sends asynchronous writes and mirrors other windows', async () => {
  await import('../../../desktop/src/preload.js');
  await window.kubusDesktopReady;
  const bridge = window.kubusDesktop!;
  expect(bridge.stateStorage.getItem('theme')).toBe('dark');
  bridge.stateStorage.setItem('theme', 'light');
  expect(transport.send.stateChanged).toHaveBeenCalledWith({ name: 'theme', value: 'light' });
  bridge.stateStorage.removeItem('theme');
  expect(bridge.stateStorage.getItem('theme')).toBeNull();
  const changed = vi.fn(); window.addEventListener('kubus:state-changed', changed);
  transport.handlers.stateChanged!({ name: 'theme', value: 'dark' });
  expect(changed).toHaveBeenCalledOnce();
  expect(bridge.stateStorage.getItem('theme')).toBe('dark');
  transport.handlers.stateChanged!({ name: 'theme', value: null });
  expect(bridge.stateStorage.getItem('theme')).toBeNull();
  window.removeEventListener('kubus:state-changed', changed);
});
it('forwards window actions and unsubscribes event handlers', async () => {
  await import('../../../desktop/src/preload.js'); await window.kubusDesktopReady;
  const bridge = window.kubusDesktop!;
  const close = vi.fn(), cycle = vi.fn(), route = vi.fn();
  const off = [bridge.onCloseTab(close), bridge.onCycleTab(cycle), bridge.onOpenRoute(route)];
  transport.handlers.closeTab!(); transport.handlers.cycleTab!(true); transport.handlers.openRoute!('/pods');
  expect(close).toHaveBeenCalledOnce(); expect(cycle).toHaveBeenCalledWith(true); expect(route).toHaveBeenCalledWith('/pods');
  off.forEach((unsubscribe) => unsubscribe()); transport.handlers.closeTab!(); expect(close).toHaveBeenCalledOnce();
  bridge.closeWindow(); bridge.minimizeWindow(); bridge.toggleMaximize();
  expect(transport.send.closeWindow).toHaveBeenCalledOnce();
  expect(transport.send.minimizeWindow).toHaveBeenCalledOnce();
  expect(transport.send.toggleMaximize).toHaveBeenCalledOnce();
  expect(await bridge.getAppInfo()).toMatchObject({ name: 'Kubus' });
  await bridge.checkForUpdate(); expect(transport.request.checkForUpdate).toHaveBeenCalledWith({});
  expect(await bridge.getPendingRoute()).toBe('/pods');
  const launch = { kind: 'tab-transfer' as const, surface: 'page' as const, windowId: 'one', transferId: 'two', title: 'Pods' };
  bridge.openWindow(launch); expect(transport.send.openWindow).toHaveBeenCalledWith(launch);
  expect(await bridge.detachTab(launch)).toBe(true);
});

it('handles keyboard commands, external links, and persistence failure notifications', async () => {
  await import('../../../desktop/src/preload.js'); await window.kubusDesktopReady;
  const close = vi.fn(), cycle = vi.fn(), failed = vi.fn();
  window.kubusDesktop!.onCloseTab(close); window.kubusDesktop!.onCycleTab(cycle);
  window.addEventListener('kubus:state-write-failed', failed);
  transport.handlers.stateWriteFailed!(); expect(failed).toHaveBeenCalledOnce();
  const press = (key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true, ...options });
    window.dispatchEvent(event); return event;
  };
  expect(press('w').defaultPrevented).toBe(true); expect(close).toHaveBeenCalledOnce();
  press('Tab', { shiftKey: true }); expect(cycle).toHaveBeenLastCalledWith(true);
  press('PageDown'); expect(cycle).toHaveBeenLastCalledWith(false);
  for (const [key, action] of [['r', 'reload'], ['q', 'quit'], ['+', 'zoom-in'], ['-', 'zoom-out'], ['0', 'zoom-reset']] as const) {
    press(key); expect(transport.send.windowAction).toHaveBeenLastCalledWith(action);
  }
  press('w', { shiftKey: true }); expect(transport.send.windowAction).toHaveBeenLastCalledWith('close-window');
  press('i', { shiftKey: true }); expect(transport.send.windowAction).toHaveBeenLastCalledWith('devtools');
  press('F11', { ctrlKey: false }); expect(transport.send.windowAction).toHaveBeenLastCalledWith('fullscreen');
  expect(press('x').defaultPrevented).toBe(false);
  document.body.innerHTML = '<a href="https://example.com"><span>External</span></a><button>Local</button>';
  document.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(transport.send.openExternal).toHaveBeenCalledWith('https://example.com/');
  document.querySelector('button')!.click();
  expect(transport.send.openExternal).toHaveBeenCalledOnce();
});
