import type { ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { HelmOperation, HelmOperationProgressPhase } from '@kubus/shared';
import { AgeCell } from './AgeCell.js';

const PHASE_LABELS: Record<HelmOperationProgressPhase, string> = {
  queued: 'Queued',
  'resolving-chart': 'Resolving chart',
  rendering: 'Rendering',
  'pre-hook': 'Pre-hooks',
  applying: 'Applying',
  pruning: 'Pruning',
  readiness: 'Readiness',
  'post-hook': 'Post-hooks',
  recording: 'Recording',
  completed: 'Completed',
};

export function helmOperationPhaseLabel(phase: HelmOperationProgressPhase): string {
  return PHASE_LABELS[phase];
}

export function helmOperationReleaseKey(operation: Pick<HelmOperation, 'ctx' | 'namespace' | 'releaseName'>): string {
  return `${operation.ctx}/${operation.namespace}/${operation.releaseName}`;
}

function operationTitle(operation: HelmOperation): string {
  const action = operation.kind[0]!.toUpperCase() + operation.kind.slice(1);
  if (operation.status === 'running') return `${action} in progress`;
  if (operation.status === 'failed') return `${action} failed`;
  return `${action} completed`;
}

function ResultSummary({ operation }: { operation: HelmOperation }) {
  const result = operation.result;
  if (!result) return null;
  const revision = 'revision' in result ? result.revision : result.newRevision;
  return (
    <Stack direction="row" sx={{ gap: 0.75, flexWrap: 'wrap', mt: 0.75 }}>
      <Chip size="small" variant="outlined" label={`revision ${revision}`} />
      <Chip size="small" variant="outlined" label={`${result.applied.length} applied`} />
      {result.pruned.length ? <Chip size="small" variant="outlined" label={`${result.pruned.length} pruned`} /> : null}
      {result.hooksRan.length ? <Chip size="small" variant="outlined" label={`${result.hooksRan.length} hooks`} /> : null}
    </Stack>
  );
}

export function HelmOperationStatus({
  operation,
  compact = false,
  action,
}: {
  operation: HelmOperation;
  compact?: boolean;
  action?: ReactNode;
}) {
  const running = operation.status === 'running';
  const severity = operation.status === 'failed' ? 'error' : operation.status === 'succeeded' ? 'success' : 'info';
  const hasProgress = running && operation.totalResources !== undefined && operation.totalResources > 0;
  const progress = hasProgress ? Math.min(100, ((operation.completedResources ?? 0) / operation.totalResources!) * 100) : undefined;

  return (
    <Alert
      severity={severity}
      sx={{ alignItems: 'flex-start', '& .MuiAlert-message': { width: '100%', minWidth: 0 } }}
      action={action}
    >
      <AlertTitle sx={{ mb: 0.25 }}>
        {operationTitle(operation)} · {operation.namespace}/{operation.releaseName}
      </AlertTitle>
      <Stack direction="row" sx={{ gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip size="small" label={helmOperationPhaseLabel(operation.phase)} variant="outlined" />
        {operation.targetVersion ? <Chip size="small" label={`target ${operation.targetVersion}`} variant="outlined" /> : null}
        {operation.targetRevision ? <Chip size="small" label={`target rev ${operation.targetRevision}`} variant="outlined" /> : null}
        {operation.revision ? <Chip size="small" label={`new rev ${operation.revision}`} variant="outlined" /> : null}
        <Typography variant="caption" color="text.secondary">
          updated <AgeCell timestamp={operation.updatedAt} variant="caption" /> ago
        </Typography>
      </Stack>

      <Typography variant="body2" sx={{ mt: 0.75, overflowWrap: 'anywhere' }}>
        {operation.error ?? operation.message}
      </Typography>

      {running ? (
        <Box sx={{ mt: 1 }}>
          <LinearProgress variant={hasProgress ? 'determinate' : 'indeterminate'} value={progress} />
          {hasProgress ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.35 }}>
              {operation.completedResources ?? 0} of {operation.totalResources} {operation.phase === 'readiness' ? 'workloads ready' : 'resources'}
            </Typography>
          ) : null}
        </Box>
      ) : null}

      {operation.currentResource ? (
        <Typography variant="caption" component="div" sx={{ mt: 0.75, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
          {operation.currentResource}
        </Typography>
      ) : null}

      {running && operation.waitingFor?.length ? (
        <Box sx={{ mt: 0.75 }}>
          <Typography variant="caption" sx={{ fontWeight: 650 }}>
            Waiting for
          </Typography>
          {operation.waitingFor.slice(0, compact ? 3 : 8).map((item) => (
            <Typography key={item.resource} variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: 'anywhere' }}>
              {item.resource}: {item.message}
            </Typography>
          ))}
          {operation.waitingFor.length > (compact ? 3 : 8) ? (
            <Typography variant="caption" color="text.secondary">
              +{operation.waitingFor.length - (compact ? 3 : 8)} more
            </Typography>
          ) : null}
        </Box>
      ) : null}

      {operation.status === 'failed' && operation.failure ? (
        <Box sx={{ mt: 1 }}>
          {operation.failure.failed.slice(0, compact ? 2 : 5).map((item) => (
            <Typography key={`${item.resource}/${item.error}`} variant="caption" component="div" sx={{ overflowWrap: 'anywhere' }}>
              <b>{item.resource}:</b> {item.error}
            </Typography>
          ))}
          {!compact ? (
            <>
              <Typography variant="subtitle2" sx={{ mt: 1 }}>
                Recovery guidance
              </Typography>
              {operation.failure.recoveryRevision ? (
                <Typography variant="body2" color="text.secondary">
                  Revision {operation.failure.recoveryRevision} is the last known successful manifest. A rollback can restore Kubernetes objects, but it cannot
                  reverse database migrations or persisted-data changes.
                </Typography>
              ) : null}
              {operation.failure.suggestions.map((suggestion) => (
                <Typography key={suggestion} variant="body2" color="text.secondary" sx={{ mt: 0.35 }}>
                  • {suggestion}
                </Typography>
              ))}
            </>
          ) : null}
        </Box>
      ) : null}

      {operation.status === 'succeeded' ? <ResultSummary operation={operation} /> : null}
    </Alert>
  );
}
