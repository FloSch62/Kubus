import { contextBridge, ipcRenderer } from 'electron';

// Desktop bridge for stable client state plus native window integrations.
contextBridge.exposeInMainWorld('kubusDesktop', {
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
});
