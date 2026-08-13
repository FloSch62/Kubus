import { contextBridge, ipcRenderer } from 'electron';
import type { AppWindowLaunch } from '@kubus/shared';

// Client state is mirrored here and persisted with fire-and-forget messages.
// sendSync is deliberately avoided for the steady-state path: it parks the
// renderer main thread in an untimed wait, and a single lost reply (seen in
// the wild under rapid-fire writes) freezes the whole UI permanently. The one
// sync call left is the boot-time snapshot below, before the page loads.
const stateSnapshot: Record<string, string> = (() => {
  try {
    const all = ipcRenderer.sendSync('kubus:state:get-all') as unknown;
    return all && typeof all === 'object' ? (all as Record<string, string>) : {};
  } catch {
    return {};
  }
})();

const windowLaunch: AppWindowLaunch | undefined = (() => {
  try {
    const value: unknown = ipcRenderer.sendSync('kubus:window-launch');
    return value && typeof value === 'object' ? (value as AppWindowLaunch) : undefined;
  } catch {
    return undefined;
  }
})();

// The disk-side write failed in the main process: mirror the snapshot into
// origin-scoped localStorage so a relaunch on the same origin can migrate it
// back (kubusStateStorage.getItem reads browser storage when the desktop
// store has no value).
ipcRenderer.on('kubus:state:write-failed', () => {
  try {
    for (const [name, value] of Object.entries(stateSnapshot)) window.localStorage.setItem(name, value);
  } catch {
    /* browser storage unavailable — nothing left to fall back to */
  }
});

// Other native windows share the main-process state cache. Mirror changes
// into this preload snapshot, then ask the matching Zustand store to rehydrate.
ipcRenderer.on('kubus:state:changed', (_event, name: unknown, value: unknown) => {
  if (typeof name !== 'string') return;
  if (typeof value === 'string') stateSnapshot[name] = value;
  else if (value === null) delete stateSnapshot[name];
  else return;
  window.dispatchEvent(new CustomEvent('kubus:state-changed', { detail: { name } }));
});

// Desktop bridge for stable client state plus native window integrations.
contextBridge.exposeInMainWorld('kubusDesktop', {
  platform: process.platform,
  windowLaunch,
  stateStorage: {
    getItem(name: string): string | null {
      return stateSnapshot[name] ?? null;
    },
    setItem(name: string, value: string): void {
      stateSnapshot[name] = value;
      ipcRenderer.send('kubus:state:set-item', name, value);
    },
    removeItem(name: string): void {
      delete stateSnapshot[name];
      ipcRenderer.send('kubus:state:remove-item', name);
    },
  },
  setTitleBarOverlay(options: { color: string; symbolColor: string }) {
    ipcRenderer.send('kubus:set-titlebar-overlay', options);
  },
  getAppInfo() {
    return ipcRenderer.invoke('kubus:get-app-info');
  },
  checkForUpdate(options?: { force?: boolean }) {
    return ipcRenderer.invoke('kubus:check-for-update', options);
  },
  openWindow(launch: AppWindowLaunch): void {
    ipcRenderer.send('kubus:open-window', launch);
  },
  detachTab(launch: Extract<AppWindowLaunch, { kind: 'tab-transfer' }>): Promise<boolean> {
    return ipcRenderer.invoke('kubus:detach-tab', launch) as Promise<boolean>;
  },
  // Fires when the user presses the OS close-window chord (Cmd/Ctrl+W). Returns
  // an unsubscribe. The renderer closes the focused dock tab or page tab; it
  // never closes the window from this chord.
  onCloseTab(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on('kubus:close-tab', listener);
    return () => ipcRenderer.removeListener('kubus:close-tab', listener);
  },
  // Fires on the tab-cycling chords (Ctrl+Tab, Ctrl+PgUp/PgDn, macOS
  // Cmd+Shift+[/]); backwards=true cycles left. Returns an unsubscribe.
  onCycleTab(callback: (backwards: boolean) => void): () => void {
    const listener = (_event: unknown, backwards: unknown): void => callback(backwards === true);
    ipcRenderer.on('kubus:cycle-tab', listener);
    return () => ipcRenderer.removeListener('kubus:cycle-tab', listener);
  },
  // Fires when the OS opens a kubus:// deep link; the payload is an in-app
  // route ("/r/apps/v1/deployments?sel=…"). Returns an unsubscribe.
  onOpenRoute(callback: (route: string) => void): () => void {
    const listener = (_event: unknown, route: unknown): void => {
      if (typeof route === 'string') callback(route);
    };
    ipcRenderer.on('kubus:open-route', listener);
    return () => ipcRenderer.removeListener('kubus:open-route', listener);
  },
  // Call once after onOpenRoute: marks the renderer ready for pushed links and
  // returns any deep link the OS delivered before the UI was up.
  getPendingRoute(): Promise<string | null> {
    return ipcRenderer.invoke('kubus:get-pending-route') as Promise<string | null>;
  },
  closeWindow(): void {
    ipcRenderer.send('kubus:close-window');
  },
});
