import type { RPCSchema } from 'electrobun/main';
import type { AppInfo, AppWindowLaunch, UpdateCheckResult } from '@kubus/shared';

export type WindowAction = 'quit' | 'close-tab' | 'close-window' | 'previous-tab' | 'next-tab' | 'reload' | 'devtools' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'fullscreen';

export type DesktopRPC = {
  bun: RPCSchema<{
    requests: {
      bootstrap: { params: undefined; response: { platform: string; state: Record<string, string>; launch?: AppWindowLaunch } };
      getAppInfo: { params: undefined; response: AppInfo };
      checkForUpdate: { params: { force?: boolean }; response: UpdateCheckResult };
      getPendingRoute: { params: undefined; response: string | null };
      detachTab: { params: AppWindowLaunch; response: boolean };
    };
    messages: {
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
      stateChanged: { name: string; value: string | null };
      stateWriteFailed: undefined;
      closeTab: undefined;
      cycleTab: boolean;
      openRoute: string;
    };
  }>;
};
