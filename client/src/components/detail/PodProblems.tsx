import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { AgeCell } from '../AgeCell.js';
import { useResourceEvents } from '../../api/queries.js';

interface Problem {
  /** What is failing: a condition type or a container name. */
  source: string;
  reason: string;
  message?: string;
}

interface ContainerStateDetail {
  reason?: string;
  message?: string;
  exitCode?: number;
}

interface ContainerStatusShape {
  name: string;
  state?: { waiting?: ContainerStateDetail; terminated?: ContainerStateDetail; running?: unknown };
}

interface PodStatusShape {
  phase?: string;
  reason?: string;
  message?: string;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  containerStatuses?: ContainerStatusShape[];
  initContainerStatuses?: ContainerStatusShape[];
}

/** Everything currently keeping the pod from Running/Ready, in display order. */
function podProblems(obj: KubeObject): Problem[] {
  const status = obj.status as PodStatusShape | undefined;
  if (!status) return [];
  const problems: Problem[] = [];
  // Pod-level reason (e.g. Evicted pods carry it here, not in conditions).
  if (status.reason && status.phase !== 'Succeeded') {
    problems.push({ source: 'Pod', reason: status.reason, message: status.message });
  }
  for (const c of status.conditions ?? []) {
    // Ready/ContainersReady only aggregate the per-container states listed below.
    if (c.type === 'Ready' || c.type === 'ContainersReady') continue;
    if (c.status === 'True' || (!c.reason && !c.message)) continue;
    problems.push({ source: c.type, reason: c.reason ?? `${c.type}=${c.status}`, message: c.message });
  }
  const containers = [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])];
  for (const cs of containers) {
    const waiting = cs.state?.waiting;
    if (waiting) {
      problems.push({ source: cs.name, reason: waiting.reason ?? 'Waiting', message: waiting.message });
      continue;
    }
    const terminated = cs.state?.terminated;
    if (terminated && terminated.exitCode !== undefined && terminated.exitCode !== 0) {
      problems.push({
        source: cs.name,
        reason: `${terminated.reason ?? 'Terminated'} (exit ${terminated.exitCode})`,
        message: terminated.message,
      });
    }
  }
  return problems;
}

type EventShape = KubeObject & { type?: string; reason?: string; message?: string; count?: number; lastTimestamp?: string };

function eventTime(e: EventShape): string {
  return e.lastTimestamp ?? e.metadata.creationTimestamp ?? '';
}

/**
 * The `kubectl describe` answer to "why is my pod stuck": every failing
 * condition and container state plus the recent warning events (mount
 * failures, image-pull detail, scheduling), live at the top of the overview
 * instead of buried in tooltips and the Events tab.
 */
export function PodProblems({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const problems = useMemo(() => podProblems(obj), [obj]);
  const status = obj.status as PodStatusShape | undefined;
  const phase = status?.phase;
  const active = phase !== 'Succeeded' && (problems.length > 0 || phase === 'Pending' || phase === 'Failed' || phase === 'Unknown');
  const eventsQuery = useResourceEvents(
    active ? { ctx, name: obj.metadata.name, kind: 'Pod', namespace: obj.metadata.namespace } : undefined,
  );
  if (!active) return null;

  const events = (eventsQuery.data?.items ?? []) as EventShape[];
  const recent = [...events].sort((a, b) => eventTime(b).localeCompare(eventTime(a)));
  let shown = recent.filter((e) => e.type === 'Warning').slice(0, 5);
  // No warnings yet (e.g. a slow image pull): the latest normal event still
  // tells the user what the pod is doing right now.
  if (!shown.length) shown = recent.slice(0, 1);

  return (
    <Alert severity={phase === 'Failed' ? 'error' : 'warning'} sx={{ '& .MuiAlert-message': { minWidth: 0, flex: 1 } }}>
      <AlertTitle>Why this pod isn’t ready</AlertTitle>
      <Stack spacing={0.75}>
        {problems.map((p, i) => (
          <Box key={`p:${i}`}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {p.source}: {p.reason}
            </Typography>
            {p.message && (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {p.message}
              </Typography>
            )}
          </Box>
        ))}
        {shown.map((e) => (
          <Box key={e.metadata.uid}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {e.reason ?? e.type} {e.count && e.count > 1 ? `×${e.count}` : ''}{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                <AgeCell timestamp={eventTime(e)} variant="caption" /> ago
              </Typography>
            </Typography>
            {e.message && (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {e.message}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Alert>
  );
}
