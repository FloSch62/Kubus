import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { ApiError, initAuthToken } from './api/http.js';
import { isMutationErrorHandledLocally } from './api/mutation-errors.js';
import { showErrorToast } from './state/toast.js';
import App from './App.js';
import { appWindowSurface, consumeAppWindowLaunch } from './window-management.js';
import { dockTabId, useDockStore, type DockTab } from './state/dock.js';
import { pageTabId, useTabsStore } from './state/tabs.js';
import { showToast } from './state/toast.js';
import { installCrossWindowStateSync } from './cross-window-state.js';
import { receiveTabTransfer } from './tab-transfer.js';
import { applyAppWindowContext } from './window-context.js';

initAuthToken();
installCrossWindowStateSync();

const surface = appWindowSurface();
const launch = consumeAppWindowLaunch();
const launchAppliedKey = 'kubus-window-launch-applied';
if (launch && sessionStorage.getItem(launchAppliedKey) !== launch.windowId) {
  sessionStorage.setItem(launchAppliedKey, launch.windowId);
  if (launch.context) applyAppWindowContext(launch.context);
  if (launch.kind === 'page') {
    const tab = { id: pageTabId(), ...launch.tab };
    useTabsStore.setState({ tabs: [tab], activeId: tab.id, closedPaths: [] });
  } else if (launch.kind === 'dock') {
    useDockStore.getState().addTab({ id: dockTabId(), ...launch.tab } as DockTab);
  } else {
    void (async () => {
      if (!(await receiveTabTransfer(launch.transferId, undefined, 'after', true))) {
        showToast('warning', 'The tab could not be moved from the other window.');
      }
    })();
  }
}

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    // Safety net so a failed action is never silent: mutations that handle
    // their own errors keep doing so. Unreachable-backend and stale-token
    // failures are excluded — the global status banner owns those.
    onError: (error, _variables, _context, mutation) => {
      if (mutation.options.onError) return;
      if (isMutationErrorHandledLocally(mutation.meta)) return;
      if (error instanceof ApiError && (error.status === 0 || error.status === 401)) return;
      showErrorToast(error);
    },
  }),
  defaultOptions: {
    // staleTime keeps remounts (tab switches, pane reveals) from refetching
    // data that a polled query refreshed moments ago; polling intervals are
    // unaffected. Queries that need different freshness override it locally.
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App surface={surface} />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
