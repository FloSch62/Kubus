import { Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import type { ShellTab } from '../state/dock.js';

const TerminalPaneImpl = lazy(() => import('./TerminalPaneImpl.js'));

const terminalLoading = <Box sx={{ height: '100%', bgcolor: '#16161e' }} />;

export function TerminalPane(props: { tab: ShellTab; active: boolean; focusRequest: number; reconnectRequest: number }) {
  return (
    <Suspense fallback={terminalLoading}>
      <TerminalPaneImpl {...props} />
    </Suspense>
  );
}
