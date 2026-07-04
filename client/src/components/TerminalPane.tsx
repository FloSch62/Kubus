import { Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import type { NodeShellTab, TerminalTab } from '../state/dock.js';

const TerminalPaneImpl = lazy(() => import('./TerminalPaneImpl.js'));

const terminalLoading = <Box sx={{ height: '100%', bgcolor: '#16161e' }} />;

export function TerminalPane(props: { tab: TerminalTab | NodeShellTab; active: boolean }) {
  return (
    <Suspense fallback={terminalLoading}>
      <TerminalPaneImpl {...props} />
    </Suspense>
  );
}
