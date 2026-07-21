import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { LineChart } from '@mui/x-charts/LineChart';
import { useMetricsHistory } from '../api/queries.js';
import { formatBytes, formatCpu } from './format.js';
import { SERIES_DARK, SERIES_LIGHT, timeTickFormatter } from './chart-theme.js';

import type { MetricsChartProps } from './MetricsChart.js';

export default function MetricsChartImpl({ ctx, kind, name, namespace }: MetricsChartProps) {
  const { data } = useMetricsHistory({ ctx, kind, name, namespace });
  const series = useTheme().palette.mode === 'dark' ? SERIES_DARK : SERIES_LIGHT;

  // Query in flight, or the server's poller hasn't finished its first probe —
  // availability is unknown, so don't claim metrics-server is missing yet.
  if (!data || !data.probed) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Loading metrics…
      </Typography>
    );
  }
  if (!data.available) {
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
          series={[{ data: cpuValues, label: 'mCPU', area: true, showMark: false, color: series[0] }]}
          xAxis={[{ data: times, scaleType: 'time', valueFormatter: timeTickFormatter(times) }]}
          hideLegend
          sx={{ '& .MuiLineChart-area': { fillOpacity: 0.25 } }}
        />
      </Box>
      <Box>
        <Typography variant="subtitle2">Memory — {formatBytes(latest.memBytes)}</Typography>
        <LineChart
          height={180}
          series={[{ data: memValues, label: 'MiB', area: true, showMark: false, color: series[1] }]}
          xAxis={[{ data: times, scaleType: 'time', valueFormatter: timeTickFormatter(times) }]}
          hideLegend
          sx={{ '& .MuiLineChart-area': { fillOpacity: 0.25 } }}
        />
      </Box>
    </Stack>
  );
}
