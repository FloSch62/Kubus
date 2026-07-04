import { Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import type { TopologyFocus } from '../api/queries.js';

export interface TopologyGraphProps {
  contexts: string[];
  namespaces: string[];
  focus?: TopologyFocus;
  hideDisconnected?: boolean;
  emptyTitle?: string;
}

const TopologyGraphImpl = lazy(() => import('./TopologyGraphImpl.js'));

const graphLoading = <Box sx={{ height: '100%', minHeight: 360, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default' }} />;

export function TopologyGraph(props: TopologyGraphProps) {
  return (
    <Suspense fallback={graphLoading}>
      <TopologyGraphImpl {...props} />
    </Suspense>
  );
}
