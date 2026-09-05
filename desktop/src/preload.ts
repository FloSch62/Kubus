import { Electroview } from 'electrobun/view';
import type { DesktopRPC, WindowAction } from './rpc.js';
import type { AppWindowLaunch } from '@kubus/shared';

const state: Record<string, string> = Object.create(null);
const closeListeners = new Set<() => void>();
const cycleListeners = new Set<(backwards: boolean) => void>();
const routeListeners = new Set<(route: string) => void>();
const subscribe = <T>(listeners: Set<T>, listener: T) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const rpc = Electroview.defineRPC<DesktopRPC>({
  maxRequestTime: 15_000,
  handlers: {
    requests: {},
    messages: {
      stateChanged: ({ name, value }) => {
        if (value === null) delete state[name];
        else state[name] = value;
        window.dispatchEvent(new CustomEvent('kubus:state-changed', { detail: { name } }));
      },
      stateWriteFailed: () => {
        window.dispatchEvent(new CustomEvent('kubus:state-write-failed'));
      },
      closeTab: () => closeListeners.forEach((callback) => callback()),
      cycleTab: (backwards) => cycleListeners.forEach((callback) => callback(backwards)),
      openRoute: (route) => routeListeners.forEach((callback) => callback(route)),
    },
  },
});
new Electroview({ rpc });

// Hydrate before importing the SPA: Zustand reads persisted state at module load.
window.kubusDesktopReady = rpc.request.bootstrap().then(({ platform, state: snapshot, launch }) => {
  Object.assign(state, snapshot);
  window.kubusDesktop = {
    platform,
    windowLaunch: launch,
    stateStorage: {
      getItem: (name: string) => state[name] ?? null,
      setItem(name: string, value: string) {
        state[name] = value;
        rpc.send.stateChanged({ name, value });
      },
      removeItem(name: string) {
        delete state[name];
        rpc.send.stateChanged({ name, value: null });
      },
    },
    getAppInfo: () => rpc.request.getAppInfo(),
    checkForUpdate: (options = {}) => rpc.request.checkForUpdate(options),
    openWindow: (value: AppWindowLaunch) => rpc.send.openWindow(value),
    detachTab: (value: Extract<AppWindowLaunch, { kind: 'tab-transfer' }>) => rpc.request.detachTab(value),
    onCloseTab: (callback: () => void) => subscribe(closeListeners, callback),
    onCycleTab: (callback: (backwards: boolean) => void) => subscribe(cycleListeners, callback),
    onOpenRoute: (callback: (route: string) => void) => subscribe(routeListeners, callback),
    getPendingRoute: () => rpc.request.getPendingRoute(),
    closeWindow: () => rpc.send.closeWindow(),
    minimizeWindow: () => rpc.send.minimizeWindow(),
    toggleMaximize: () => rpc.send.toggleMaximize(),
  };

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const mod = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    // Linux has no native application menu. Dispatch window commands through
    // the same typed handler used by menu actions on macOS and Windows.
    let action: WindowAction | undefined;
    if (mod && !event.altKey) {
      if (key === 'w' && event.shiftKey) action = 'close-window';
      else if (key === 'r') action = 'reload';
      else if (key === 'q') action = 'quit';
      else if (key === '+' || key === '=') action = 'zoom-in';
      else if (key === '-') action = 'zoom-out';
      else if (key === '0') action = 'zoom-reset';
      else if (key === 'i' && event.shiftKey) action = 'devtools';
    }
    if (key === 'f11' && !mod) action = 'fullscreen';
    if (action) {
      event.preventDefault();
      rpc.send.windowAction(action);
      return;
    }
    if (mod && key === 'w' && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      closeListeners.forEach((callback) => callback());
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && ['tab', 'pageup', 'pagedown'].includes(key)) {
      event.preventDefault();
      cycleListeners.forEach((callback) => callback(key === 'tab' ? event.shiftKey : key === 'pageup'));
    }
  }, true);
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin && ['https:', 'http:', 'mailto:'].includes(url.protocol)) {
      event.preventDefault();
      rpc.send.openExternal(url.href);
    }
  }, true);
});
