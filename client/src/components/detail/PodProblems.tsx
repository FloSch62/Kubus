import { useMemo } from 'react';
import type { KubeObject } from '@kubus/shared';
import { useResourceEvents } from '../../api/queries.js';
import { ProblemBanner, type ProblemItem } from './ProblemBanner.js';

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

/**
 * Why a pod is stuck: every failing condition and container state plus the
 * recent warning events (mount failures, image-pull detail, scheduling),
 * live at the top of the overview instead of buried in tooltips and the
 * Events tab.
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

  const items: ProblemItem[] = [
    ...problems,
    ...shown.map((e) => ({ title: e.reason ?? e.type ?? 'Event', message: e.message, count: e.count, at: eventTime(e) })),
  ];
  return <ProblemBanner severity={phase === 'Failed' ? 'error' : 'warning'} title="Why this pod isn’t ready" items={items} />;
}
