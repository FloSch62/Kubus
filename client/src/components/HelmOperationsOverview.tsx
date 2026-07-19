import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import PendingActionsOutlinedIcon from '@mui/icons-material/PendingActionsOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { HelmOperation } from '@kubus/shared';
import { useNavigate } from 'react-router';
import { HelmOperationStatus, helmOperationReleaseKey } from './HelmOperationStatus.js';

const MAX_RECENT_OPERATIONS = 10;
const INSTALL_PRE_RELEASE_PHASES = new Set<HelmOperation['phase']>(['queued', 'resolving-chart', 'rendering']);

interface Props {
  operations: HelmOperation[];
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}

function canOpenRelease(operation: HelmOperation): boolean {
  return operation.kind !== 'install' || !INSTALL_PRE_RELEASE_PHASES.has(operation.phase);
}

export function HelmOperationsOverview({ operations, error, isLoading, isFetching, onRefresh }: Props) {
  const navigate = useNavigate();
  const [showHistory, setShowHistory] = useState(false);
  const attentionOperations = useMemo(() => {
    const latestByRelease = new Map<string, HelmOperation>();
    for (const operation of operations) {
      const key = helmOperationReleaseKey(operation);
      if (!latestByRelease.has(key)) latestByRelease.set(key, operation);
    }
    return [...latestByRelease.values()].filter((operation) => operation.status !== 'succeeded');
  }, [operations]);
  const runningCount = attentionOperations.filter((operation) => operation.status === 'running').length;
  const failedCount = attentionOperations.length - runningCount;
  const displayedOperations = showHistory ? operations.slice(0, MAX_RECENT_OPERATIONS) : attentionOperations;

  if (!isLoading && !error && operations.length === 0) return null;

  return (
    <Box sx={{ mb: 1.25, border: 1, borderColor: 'divider', borderRadius: 1, flexShrink: 0 }}>
      <Stack direction="row" sx={{ minHeight: 42, px: 1.25, alignItems: 'center', gap: 0.75 }}>
        <PendingActionsOutlinedIcon fontSize="small" color={runningCount ? 'primary' : 'inherit'} />
        <Typography variant="subtitle2">Helm operations</Typography>
        {runningCount > 0 ? <Chip size="small" color="info" label={`${runningCount} running`} /> : null}
        {failedCount > 0 ? <Chip size="small" color="error" variant="outlined" label={`${failedCount} failed`} /> : null}
        {!isLoading && runningCount === 0 && failedCount === 0 ? (
          <Typography variant="caption" color="text.secondary">
            No operations need attention
          </Typography>
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh Helm operations">
          <span>
            <IconButton size="small" onClick={onRefresh} disabled={isFetching} aria-label="Refresh Helm operations">
              {isFetching ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        {operations.length > 0 ? (
          <Button size="small" onClick={() => setShowHistory((visible) => !visible)}>
            {showHistory ? 'Hide recent' : `Recent (${operations.length})`}
          </Button>
        ) : null}
      </Stack>

      {isLoading ? <LinearProgress /> : null}
      {error ? (
        <Alert severity="error" sx={{ borderRadius: 0 }}>
          {error.message}
        </Alert>
      ) : null}
      {displayedOperations.length > 0 ? (
        <Stack spacing={1} sx={{ maxHeight: 320, overflowY: 'auto', borderTop: 1, borderColor: 'divider', p: 1 }}>
          {displayedOperations.map((operation) => (
            <HelmOperationStatus
              key={operation.id}
              operation={operation}
              compact={operation.status === 'succeeded'}
              action={
                canOpenRelease(operation) ? (
                  <Button
                    color="inherit"
                    size="small"
                    sx={{ whiteSpace: 'nowrap' }}
                    onClick={() =>
                      void navigate(
                        `/helm/${encodeURIComponent(operation.ctx)}/${encodeURIComponent(operation.namespace)}/${encodeURIComponent(operation.releaseName)}`,
                      )
                    }
                  >
                    Open release
                  </Button>
                ) : undefined
              }
            />
          ))}
          {showHistory && operations.length > MAX_RECENT_OPERATIONS ? (
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
              Showing the {MAX_RECENT_OPERATIONS} most recent operations.
            </Typography>
          ) : null}
        </Stack>
      ) : null}
    </Box>
  );
}
