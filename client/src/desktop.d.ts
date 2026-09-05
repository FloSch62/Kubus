import type { AppInfo, AppWindowLaunch, UpdateCheckResult } from '@kubus/shared';

declare global {
  /** Bridge exposed by the Electrobun preload (absent in regular browsers). */
  interface Window {
    kubusDesktopReady?: Promise<void>;
    kubusDesktop?: {
      /** Host process.platform ('linux', 'win32', 'darwin', …). */
      platform: string;
      /** One-shot payload describing the content of a secondary app window. */
      windowLaunch?: AppWindowLaunch;
      stateStorage: {
        getItem(name: string): string | null;
        setItem(name: string, value: string): void;
        removeItem(name: string): void;
      };
      minimizeWindow(): void;
      toggleMaximize(): void;
      getAppInfo(): Promise<AppInfo | undefined>;
      checkForUpdate(options?: { force?: boolean }): Promise<UpdateCheckResult>;
      /** Open a secondary native application window. */
      openWindow(launch: AppWindowLaunch): void;
      /** Detach only if the native cursor is outside every Kubus window. */
      detachTab(launch: Extract<AppWindowLaunch, { kind: 'tab-transfer' }>): Promise<boolean>;
      /** Subscribe to the OS close-window chord (Cmd/Ctrl+W); returns unsubscribe. */
      onCloseTab(callback: () => void): () => void;
      /** Subscribe to the tab-cycling chords (Ctrl+Tab & friends); backwards=true cycles left. */
      onCycleTab(callback: (backwards: boolean) => void): () => void;
      /** Subscribe to kubus:// deep links; the payload is an in-app route. Returns unsubscribe. */
      onOpenRoute(callback: (route: string) => void): () => void;
      /** Fetch a deep link delivered before the UI was ready (cold start); marks the renderer ready for pushes. */
      getPendingRoute(): Promise<string | null>;
      /** Close the main window (fallback when no dock tab is open). */
      closeWindow(): void;
    };
  }
}

export {};
