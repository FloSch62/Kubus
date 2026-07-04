import { memo } from 'react';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';

interface Props {
  values: number[];
  label: string;
  color?: string;
}

export const Sparkline = memo(function Sparkline({ values, label, color = '#7aa2f7' }: Props) {
  if (!values.length) return null;
  return (
    <Tooltip title={label}>
      <Box sx={{ width: 80, height: 24 }}>
        <SparkLineChart data={values} height={24} width={80} color={color} />
      </Box>
    </Tooltip>
  );
});

export function formatCpu(milli: number): string {
  return milli >= 1000 ? `${(milli / 1000).toFixed(2)} cores` : `${milli}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)}Gi`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(0)}Mi`;
  if (bytes >= 2 ** 10) return `${(bytes / 2 ** 10).toFixed(0)}Ki`;
  return `${bytes}B`;
}
