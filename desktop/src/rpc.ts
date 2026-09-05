import type { RPCSchema } from 'electrobun/main';
import type { AppInfo, AppWindowLaunch, AppUpdateState } from '@kubus/shared';

export type WindowAction = 'quit' | 'close-tab' | 'close-window' | 'previous-tab' | 'next-tab' | 'reload' | 'devtools' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'fullscreen';

export type DesktopRPC = {
  bun: RPCSchema<{
    requests: {
      bootstrap: { params: undefined; response: { platform: string; state: Record<string, string>; launch?: AppWindowLaunch; update: AppUpdateState } };
      getAppInfo: { params: undefined; response: AppInfo };
      getPendingRoute: { params: undefined; response: string | null };
      detachTab: { params: AppWindowLaunch; response: boolean };
    };
    messages: {
      checkForUpdate: undefined;
      downloadUpdate: undefined;
      applyUpdate: undefined;
      stateChanged: { name: string; value: string | null };
      openWindow: AppWindowLaunch;
      windowAction: WindowAction;
      closeWindow: undefined;
      minimizeWindow: undefined;
      toggleMaximize: undefined;
      openExternal: string;
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      updateStateChanged: AppUpdateState;
      stateChanged: { name: string; value: string | null };
      stateWriteFailed: undefined;
      closeTab: undefined;
      cycleTab: boolean;
      openRoute: string;
    };
  }>;
};
