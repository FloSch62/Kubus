import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { buildTheme } from './theme.js';
import { setTitleBarMode } from './titlebar-overlay.js';
import { useContextsInvalidation } from './api/queries.js';
import { useClustersStore } from './state/clusters.js';
import { AppRouter } from './router.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ToastHost } from './components/ToastHost.js';
import { BackendStatusBanner } from './components/BackendStatusBanner.js';
import { UpdateNotification } from './components/UpdateNotification.js';
import { TitleBarAwareBackdrop } from './components/TitleBarAwareBackdrop.js';
import { setDebugLogging } from './api/logs.js';
import { useUiPrefsStore } from './state/prefs.js';
import { useUiStore } from './state/ui.js';

const LogViewerDialog = lazy(() => import('./components/LogViewerDialog.js').then((module) => ({ default: module.LogViewerDialog })));

export default function App() {
  // One app-wide subscription keeps context/discovery queries fresh.
  useContextsInvalidation();
  const themeMode = useClustersStore((s) => s.themeMode);
  const debugMode = useUiPrefsStore((state) => state.debugMode);
  const logViewerOpen = useUiStore((state) => state.logViewerOpen);
  const [osTheme, setOsTheme] = useState<'light' | 'dark'>(() =>
    //Check the operating system’s current color scheme and return true if it is dark, false otherwise
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  const effectiveMode = themeMode === 'os' ? osTheme : themeMode;
  const theme = useMemo(() => buildTheme(effectiveMode, { modalBackdrop: TitleBarAwareBackdrop }), [effectiveMode]);
  useLayoutEffect(() => {
    // Keep the desktop app's native window controls in sync with the theme.
    setTitleBarMode(effectiveMode);
  }, [effectiveMode]);
  useEffect(() => {
    // The debug preference is client-side; keep the server's live level in sync.
    void setDebugLogging(debugMode).catch(() => undefined);
  }, [debugMode]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setOsTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary label="Kubus">
        <AppRouter />
      </ErrorBoundary>
      <ToastHost />
      <BackendStatusBanner />
      <UpdateNotification />
      <Suspense fallback={null}>{logViewerOpen ? <LogViewerDialog /> : null}</Suspense>
    </ThemeProvider>
  );
}
