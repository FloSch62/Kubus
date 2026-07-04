import { Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

export interface MetricsChartProps {
  ctx: string;
  kind: 'pod' | 'node';
  name: string;
  namespace?: string;
}

const MetricsChartImpl = lazy(() => import('./MetricsChartImpl.js'));

const chartLoading = (
  <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
    <CircularProgress size={24} />
  </Box>
);

export function MetricsChart(props: MetricsChartProps) {
  return (
    <Suspense fallback={chartLoading}>
      <MetricsChartImpl {...props} />
    </Suspense>
  );
}
