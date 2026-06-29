import { useEffect, useMemo, useState } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { buildTheme, titleBarColors } from './theme.js';
import { useClustersStore } from './state/clusters.js';
import { AppRouter } from './router.js';
import { UpdateNotification } from './components/UpdateNotification.js';

export default function App() {
  const themeMode = useClustersStore((s) => s.themeMode);
  const [osTheme, setOsTheme] = useState<'light' | 'dark'>(() =>
    //Check the operating system’s current color scheme and return true if it is dark, false otherwise
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  const effectiveMode = themeMode === 'os' ? osTheme : themeMode;
  const theme = useMemo(() => buildTheme(effectiveMode), [effectiveMode]);
  useEffect(() => {
    // Keep the desktop app's native window controls in sync with the theme.
    window.kubusDesktop?.setTitleBarOverlay(titleBarColors(effectiveMode));
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
