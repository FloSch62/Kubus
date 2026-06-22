import { useEffect, useMemo } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { buildTheme, titleBarColors } from './theme.js';
import { useClustersStore } from './state/clusters.js';
import { AppRouter } from './router.js';

export default function App() {
  const mode = useClustersStore((s) => s.themeMode);
  const theme = useMemo(() => buildTheme(mode), [mode]);
  useEffect(() => {
    // Keep the desktop app's native window controls in sync with the theme.
    window.kubusDesktop?.setTitleBarOverlay(titleBarColors(mode));
  }, [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppRouter />
    </ThemeProvider>
  );
}
