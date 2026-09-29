import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { LineChart } from '@mui/x-charts/LineChart';
import { useMetricsHistory } from '../api/queries.js';
import { formatBytes, formatCpu } from './format.js';
import { formatAxisValue, metricColors, niceValueTicks, timeAxisTicks } from './chart-theme.js';

import type { MetricsChartProps } from './MetricsChart.js';

export default function MetricsChartImpl({ ctx, kind, name, namespace }: MetricsChartProps) {
  const { data } = useMetricsHistory({ ctx, kind, name, namespace });
  const colors = metricColors(useTheme().palette.mode);

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
    memValues.push(s.memBytes);
  }
  const latest = data.series[data.series.length - 1]!;
  const timeAxis = timeAxisTicks(times);
  const cpuTicks = niceValueTicks(Math.max(...cpuValues), 'cpu');
  const memTicks = niceValueTicks(Math.max(...memValues), 'bytes');

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Box>
        <Typography variant="subtitle2">CPU — {formatCpu(latest.cpuMilli)}</Typography>
        <LineChart
          height={180}
          series={[{ data: cpuValues, label: 'CPU', area: true, showMark: false, color: colors.cpu, valueFormatter: (v: number | null) => (v === null ? '' : formatCpu(v)) }]}
          xAxis={[{ data: times, scaleType: 'time', ...timeAxis }]}
          yAxis={[{ min: 0, max: cpuTicks.max, tickInterval: cpuTicks.tickInterval, valueFormatter: (v: number) => formatAxisValue('cpu', v), width: 64 }]}
          grid={{ horizontal: true }}
          hideLegend
          sx={{ '& .MuiLineChart-area': { fillOpacity: 0.2 } }}
        />
      </Box>
      <Box>
        <Typography variant="subtitle2">Memory — {formatBytes(latest.memBytes)}</Typography>
        <LineChart
          height={180}
          series={[{ data: memValues, label: 'Memory', area: true, showMark: false, color: colors.memory, valueFormatter: (v: number | null) => (v === null ? '' : formatBytes(v)) }]}
          xAxis={[{ data: times, scaleType: 'time', ...timeAxis }]}
          yAxis={[{ min: 0, max: memTicks.max, tickInterval: memTicks.tickInterval, valueFormatter: (v: number) => formatAxisValue('bytes', v), width: 64 }]}
          grid={{ horizontal: true }}
          hideLegend
          sx={{ '& .MuiLineChart-area': { fillOpacity: 0.2 } }}
        />
      </Box>
    </Stack>
  );
}
