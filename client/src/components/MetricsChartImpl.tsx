import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { LineChart } from '@mui/x-charts/LineChart';
import { useMetricsHistory } from '../api/queries.js';
import { formatBytes, formatCpu } from './format.js';

import type { MetricsChartProps } from './MetricsChart.js';

export default function MetricsChartImpl({ ctx, kind, name, namespace }: MetricsChartProps) {
  const { data } = useMetricsHistory({ ctx, kind, name, namespace });

  if (!data?.available) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Metrics unavailable — is metrics-server installed in this cluster?
      </Typography>
    );
  }
  if (!data.series.length) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Collecting samples… check back in ~20 seconds.
      </Typography>
    );
  }

  const times: Date[] = [];
  const cpuValues: number[] = [];
  const memValues: number[] = [];
  for (const s of data.series) {
    times.push(new Date(s.t));
    cpuValues.push(s.cpuMilli);
    memValues.push(s.memBytes / 2 ** 20);
  }
  const latest = data.series[data.series.length - 1]!;

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Box>
        <Typography variant="subtitle2">CPU — {formatCpu(latest.cpuMilli)}</Typography>
        <LineChart
          height={180}
          series={[{ data: cpuValues, label: 'mCPU', area: true, showMark: false, color: '#7aa2f7' }]}
          xAxis={[{ data: times, scaleType: 'time' }]}
          hideLegend
        />
      </Box>
      <Box>
        <Typography variant="subtitle2">Memory — {formatBytes(latest.memBytes)}</Typography>
        <LineChart
          height={180}
          series={[{ data: memValues, label: 'MiB', area: true, showMark: false, color: '#9ece6a' }]}
          xAxis={[{ data: times, scaleType: 'time' }]}
          hideLegend
        />
      </Box>
    </Stack>
  );
}
