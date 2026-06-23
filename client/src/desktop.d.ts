import type { AppInfo, UpdateCheckResult } from '@kubus/shared';

declare global {
  /** Bridge exposed by the Electron preload (absent in regular browsers). */
  interface Window {
    kubusDesktop?: {
      setTitleBarOverlay(options: { color: string; symbolColor: string }): void;
      getAppInfo(): Promise<AppInfo | undefined>;
      checkForUpdate(options?: { force?: boolean }): Promise<UpdateCheckResult>;
    };
  }
}

export {};
