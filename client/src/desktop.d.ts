/** Bridge exposed by the Electron preload (absent in regular browsers). */
interface Window {
  kubusDesktop?: {
    setTitleBarOverlay(options: { color: string; symbolColor: string }): void;
  };
}
