import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { buildTheme } from './theme.js';
import { setTitleBarMode } from './titlebar-overlay.js';
import { useClustersStore } from './state/clusters.js';
import { AppRouter } from './router.js';
import { UpdateNotification } from './components/UpdateNotification.js';
import { TitleBarAwareBackdrop } from './components/TitleBarAwareBackdrop.js';

export default function App() {
  const themeMode = useClustersStore((s) => s.themeMode);
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
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setOsTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppRouter />
      <UpdateNotification />
    </ThemeProvider>
  );
}
