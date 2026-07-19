import { contextBridge, ipcRenderer } from 'electron';

// Desktop bridge for stable client state plus native window integrations.
contextBridge.exposeInMainWorld('kubusDesktop', {
  platform: process.platform,
  stateStorage: {
    getItem(name: string): string | null {
      return ipcRenderer.sendSync('kubus:state:get-item', name) as string | null;
    },
    setItem(name: string, value: string): void {
      if (!ipcRenderer.sendSync('kubus:state:set-item', name, value)) throw new Error('failed to persist desktop state');
    },
    removeItem(name: string): void {
      if (!ipcRenderer.sendSync('kubus:state:remove-item', name)) throw new Error('failed to remove desktop state');
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
  closeWindow(): void {
    ipcRenderer.send('kubus:close-window');
  },
});
