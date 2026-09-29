import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import SubjectIcon from '@mui/icons-material/Subject';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import { isRecentWarning, type KubeObject } from '@kubus/shared';
import { useResourceEvents } from '../../api/queries.js';
import { podContainerNames } from '../../kube-display.js';
import { selKeyOf, useDetailStore } from '../../state/detail.js';
import { dockTabId, useDockStore } from '../../state/dock.js';
import { ProblemBanner, ProblemItems, RawMessage, type ProblemItem } from './ProblemBanner.js';
import { commandSummary, diagnosePod, type Diagnosis } from './pod-diagnosis.js';
import { useLastOutput } from './last-output.js';

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
export function podProblems(obj: KubeObject): ProblemItem[] {
  const status = obj.status as PodStatusShape | undefined;
  if (!status) return [];
  const problems: ProblemItem[] = [];
  // Pod-level reason (e.g. Evicted pods carry it here, not in conditions).
  if (status.reason && status.phase !== 'Succeeded') {
    problems.push({ title: `Pod: ${status.reason}`, message: status.message });
  }
  for (const c of status.conditions ?? []) {
    // Ready/ContainersReady only aggregate the per-container states listed below.
    if (c.type === 'Ready' || c.type === 'ContainersReady') continue;
    if (c.status === 'True' || (!c.reason && !c.message)) continue;
    problems.push({ title: `${c.type}: ${c.reason ?? `${c.type}=${c.status}`}`, message: c.message });
  }
  const containers = [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])];
  for (const cs of containers) {
    const waiting = cs.state?.waiting;
    if (waiting) {
      problems.push({ title: `${cs.name}: ${waiting.reason ?? 'Waiting'}`, message: waiting.message });
      continue;
    }
    const terminated = cs.state?.terminated;
    if (terminated && terminated.exitCode !== undefined && terminated.exitCode !== 0) {
      problems.push({
        title: `${cs.name}: ${terminated.reason ?? 'Terminated'} (exit ${terminated.exitCode})`,
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

/** Recent warnings about this pod: the count the Events tab carries, so the two agree. */
function recentWarnings(events: EventShape[], uid: string | undefined): number {
  const now = Date.now();
  return events.filter((e) => {
    const involved = (e as { involvedObject?: { uid?: string } }).involvedObject?.uid;
    return isRecentWarning(e, now) && (!uid || !involved || involved === uid);
  }).length;
}

/** Event reasons a diagnosis already says in words (the back-off loop, the pull failures, the scheduler's refusals). */
function explainedReasons(diagnoses: Diagnosis[]): Set<string> {
  const reasons = new Set<string>();
  for (const d of diagnoses) {
    if (d.kind === 'crashloop') reasons.add('BackOff');
    if (d.kind === 'image') ['BackOff', 'Failed', 'Pulling', 'ErrImagePull', 'ImagePullBackOff', 'InspectFailed'].forEach((r) => reasons.add(r));
    if (d.kind === 'config' || d.kind === 'start') reasons.add('Failed');
    if (d.kind === 'unschedulable') reasons.add('FailedScheduling');
  }
  return reasons;
}

/** Time of day a run ended, for the caption under its output. */
function clockTime(timestamp: string | undefined): string | undefined {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString();
}

function LastOutput({ d, ctx, namespace, pod }: { d: Diagnosis; ctx: string; namespace: string; pod: string }) {
  const output = useLastOutput(
    d.logs && d.container ? { ctx, namespace, pod, container: d.container, previous: d.logs === 'previous' } : undefined,
    d.finishedAt,
  );
  if (!output) return null;
  const ended = [d.exitCode !== undefined ? `exit code ${d.exitCode}` : undefined, clockTime(d.finishedAt)].filter(Boolean).join(' · ');
  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'text.secondary', mb: 0.5 }}>
        {d.logs === 'previous' ? 'Last output before exit' : 'Last output'}
      </Typography>
      {/* Log surfaces stay dark in both themes, like the log viewer. */}
      <Box
        aria-label={`Last output of container ${d.container}`}
        sx={{
          bgcolor: '#16161a',
          color: '#d7d7de',
          borderRadius: 1,
          px: 1.25,
          py: 0.75,
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 180,
          overflow: 'auto',
        }}
      >
        {output.status === 'loading' && <Box sx={{ color: '#8b8b95' }}>Loading…</Box>}
        {output.status !== 'loading' && output.lines.map((line, i) => <div key={i}>{line || ' '}</div>)}
        {output.status === 'done' && !output.lines.length && <Box sx={{ color: '#8b8b95' }}>The container wrote nothing before it stopped.</Box>}
        {output.status === 'error' && <Box sx={{ color: '#fca5a5' }}>{output.error ?? 'The logs could not be read.'}</Box>}
        {output.status !== 'loading' && ended && <Box sx={{ color: '#8b8b95' }}>{`── container stopped · ${ended}`}</Box>}
      </Box>
    </Box>
  );
}

/** Neutral buttons on the tinted banner: readable in both themes, not another shade of red. */
const ACTION_SX = { bgcolor: 'background.paper', color: 'text.primary', borderColor: 'divider', '&:hover': { borderColor: 'text.secondary', bgcolor: 'background.paper' } } as const;

function DiagnosisBlock({
  d,
  ctx,
  obj,
  eventCount,
  warningCount,
  command,
}: {
  d: Diagnosis;
  ctx: string;
  obj: KubeObject;
  eventCount: number;
  /** Recent warnings, the same count the Events tab shows. */
  warningCount: number;
  command?: string;
}) {
  const addTab = useDockStore((s) => s.addTab);
  const requestTab = useDetailStore((s) => s.requestTab);
  const namespace = obj.metadata.namespace ?? '';
  const pod = obj.metadata.name;
  const openLogs = () => {
    if (!d.container) return;
    addTab({
      kind: 'logs',
      id: dockTabId(),
      title: `logs: ${pod}/${d.container}${d.logs === 'previous' ? ' (previous)' : ''}`,
      ctx,
      namespace,
      pods: [pod],
      sources: [{ pod, containers: podContainerNames(obj) }],
      container: d.container,
      follow: d.logs !== 'previous',
      previous: d.logs === 'previous' || undefined,
    });
  };
  const openEvents = () => requestTab(selKeyOf({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: pod, namespace: obj.metadata.namespace }), 'events');
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography sx={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.4 }}>{d.headline}</Typography>
      {d.detail && (
        <Typography variant="body2" sx={{ mt: 0.25, opacity: 0.85 }}>
          {d.detail}
        </Typography>
      )}
      {d.logs && <LastOutput d={d} ctx={ctx} namespace={namespace} pod={pod} />}
      {(d.logs || eventCount > 0 || command) && (
        <Stack direction="row" sx={{ mt: 1, gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
          {d.logs && d.container && (
            <Button size="small" variant="outlined" color="inherit" startIcon={<SubjectIcon />} onClick={openLogs} sx={ACTION_SX}>
              {d.logs === 'previous' ? 'Previous logs' : 'Logs'}
            </Button>
          )}
          {eventCount > 0 && (
            <Button size="small" variant="outlined" color="inherit" startIcon={<NotificationsNoneOutlinedIcon />} onClick={openEvents} sx={ACTION_SX}>
              {warningCount ? `Events (${warningCount})` : 'Events'}
            </Button>
          )}
          {command && (
            <Tooltip title="The container’s command and arguments">
              <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, maxWidth: '100%' }}>
                Runs{' '}
                <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 11.5 }}>
                  {command}
                </Box>
              </Typography>
            </Tooltip>
          )}
        </Stack>
      )}
      {d.raw && <RawMessage text={d.raw} label={d.rawLabel} />}
    </Box>
  );
}

/**
 * Why a pod is stuck. Failing containers and scheduling refusals are said in
 * plain words first, with the crashed run's last output inline; whatever the
 * diagnosis does not cover (failing conditions, other warning events) stays
 * listed below as Kubernetes reports it.
 */
export function PodProblems({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const problems = useMemo(() => podProblems(obj), [obj]);
  const status = obj.status as PodStatusShape | undefined;
  const phase = status?.phase;
  const active = phase !== 'Succeeded' && (problems.length > 0 || phase === 'Pending' || phase === 'Failed' || phase === 'Unknown');
  const eventsQuery = useResourceEvents(
    active ? { ctx, name: obj.metadata.name, kind: 'Pod', namespace: obj.metadata.namespace } : undefined,
  );
  const events = useMemo(() => (eventsQuery.data?.items ?? []) as EventShape[], [eventsQuery.data]);
  const diagnoses = useMemo(() => {
    // A back-off pull message ("Back-off pulling image …") says nothing about
    // why; the latest failed-pull event usually does.
    const pullFailure = [...events].sort((a, b) => eventTime(b).localeCompare(eventTime(a))).find((e) => e.reason === 'Failed' && /pull/i.test(e.message ?? ''));
    return diagnosePod(obj, () => pullFailure?.message).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  }, [obj, events]);
  if (!active) return null;

  const recent = [...events].sort((a, b) => eventTime(b).localeCompare(eventTime(a)));
  const explained = explainedReasons(diagnoses);
  let shown = recent.filter((e) => e.type === 'Warning' && !explained.has(e.reason ?? '')).slice(0, 5);
  // No warnings yet (e.g. a slow image pull): the latest normal event still
  // tells the user what the pod is doing right now.
  if (!shown.length && !diagnoses.length) shown = recent.slice(0, 1);
  const eventItems = shown.map((e) => ({ title: e.reason ?? e.type ?? 'Event', message: e.message, count: e.count, at: eventTime(e) }));

  if (!diagnoses.length) {
    return <ProblemBanner severity={phase === 'Failed' ? 'error' : 'warning'} title="Why this pod isn’t ready" items={[...problems, ...eventItems]} />;
  }

  const covered = new Set(diagnoses.map((d) => d.container).filter(Boolean));
  const scheduling = diagnoses.some((d) => d.kind === 'unschedulable');
  const rest = problems.filter((p) => {
    if (scheduling && p.title.startsWith('PodScheduled:')) return false;
    const container = /^([^:]+): /.exec(p.title)?.[1];
    return !(container && covered.has(container));
  });
  const others = [...rest, ...eventItems];
  const spec = obj.spec as { containers?: Array<{ name: string; command?: string[]; args?: string[] }>; initContainers?: Array<{ name: string; command?: string[]; args?: string[] }> } | undefined;
  const specOf = new Map([...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].map((c) => [c.name, c]));
  const severity = diagnoses.some((d) => d.severity === 'error') || phase === 'Failed' ? 'error' : 'warning';
  const warnings = recentWarnings(events, obj.metadata.uid);

  return (
    <Alert severity={severity} aria-label="Why this pod isn’t ready" sx={{ '& .MuiAlert-message': { minWidth: 0, flex: 1 } }}>
      <Stack spacing={1.5} divider={<Divider flexItem sx={{ borderColor: 'divider' }} />}>
        {diagnoses.map((d, i) => {
          const c = d.container ? specOf.get(d.container) : undefined;
          return (
            <DiagnosisBlock
              key={`${d.kind}:${d.container ?? 'pod'}:${i}`}
              d={d}
              ctx={ctx}
              obj={obj}
              eventCount={i === 0 ? events.length : 0}
              warningCount={i === 0 ? warnings : 0}
              command={d.logs ? commandSummary(c?.command, c?.args) : undefined}
            />
          );
        })}
        {others.length > 0 && (
          <Box>
            <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'text.secondary', mb: 0.5 }}>
              Also
            </Typography>
            <ProblemItems items={others} />
          </Box>
        )}
      </Stack>
    </Alert>
  );
}
