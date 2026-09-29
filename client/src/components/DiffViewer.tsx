import { Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

const DiffViewerImpl = lazy(() => import('./DiffViewerImpl.js'));

const diffLoading = (
  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
    <CircularProgress size={24} />
  </Box>
);

export interface DiffViewerProps {
  left: string;
  right: string;
  /** Collapse unchanged regions to a few context lines around each change. */
  hideUnchanged?: boolean;
  /** Number of changed blocks, reported after every diff computation. */
  onChangeCount?: (count: number) => void;
}

export function DiffViewer(props: DiffViewerProps) {
  return (
    <Suspense fallback={diffLoading}>
      <DiffViewerImpl {...props} />
    </Suspense>
  );
}
