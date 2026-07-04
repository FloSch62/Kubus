import { Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

const DiffViewerImpl = lazy(() => import('./DiffViewerImpl.js'));

const diffLoading = (
  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
    <CircularProgress size={24} />
  </Box>
);

export function DiffViewer(props: { left: string; right: string }) {
  return (
    <Suspense fallback={diffLoading}>
      <DiffViewerImpl {...props} />
    </Suspense>
  );
}
