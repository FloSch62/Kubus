import { contextBridge, ipcRenderer } from 'electron';

// Minimal bridge: lets the web app keep the native window controls overlay
// (Windows/Linux) in sync with its own light/dark theme.
contextBridge.exposeInMainWorld('kubusDesktop', {
  setTitleBarOverlay(options: { color: string; symbolColor: string }) {
    ipcRenderer.send('kubus:set-titlebar-overlay', options);
  },
});
