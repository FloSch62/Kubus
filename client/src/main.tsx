import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { initAuthToken } from './api/http.js';
import App from './App.js';

initAuthToken();

const queryClient = new QueryClient({
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
