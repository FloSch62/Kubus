import { Component, useMemo, type ReactNode } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { buildTheme } from '@kubus/ui-theme';
import { useContext } from './bridge.js';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Empty } from './components.js';
import './style.css';

class PluginBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <Empty title="Clabernetes could not render">
        {this.state.error}
        <br />
        <button onClick={() => location.reload()}>Reload plugin</button>
      </Empty>
    ) : (
      this.props.children
    );
  }
}
function ThemedApp() {
  const { theme: mode } = useContext();
  const theme = useMemo(() => buildTheme(mode), [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <PluginBoundary>
        <App />
      </PluginBoundary>
    </ThemeProvider>
  );
}
createRoot(document.getElementById('root')!).render(<ThemedApp />);
