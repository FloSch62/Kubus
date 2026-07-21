import React from 'react';
import ReactDOM from 'react-dom/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { ApiError, initAuthToken } from './api/http.js';
import { isMutationErrorHandledLocally } from './api/mutation-errors.js';
import { showErrorToast } from './state/toast.js';
import App from './App.js';

initAuthToken();

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
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
