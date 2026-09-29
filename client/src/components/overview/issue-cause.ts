import type { OverviewWorkloadIssue, WorkloadIssueCause } from '@kubus/shared';
import { describeSchedulerMessage } from '../detail/scheduling.js';

/**
 * One line for the overview's Reason column: the Kubernetes reason as the
 * headline, then what it means for this workload in plain words. The raw
 * message stays available as `full` for the hover title.
 */
export interface IssueReason {
  /** Status word shown with a status dot: CrashLoopBackOff, Pending, FailedCreate… */
  status: string;
  /** Plain-language detail, or undefined when the status says it all. */
  detail?: string;
  /** The source message in full. */
  full?: string;
}

const PULL = new Set(['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'ErrImageNeverPull']);

/** Why an image pull fails, from containerd/kubelet's error chain. */
export function pullFailure(message: string | undefined): string {
  const m = message ?? '';
  if (/no such host|lookup .* on .*: no such host|server misbehaving/i.test(m)) return 'registry host not found';
  if (/manifest unknown|not found|404/i.test(m)) return 'image not found';
  if (/unauthorized|denied|authentication required|403/i.test(m)) return 'access denied';
  if (/i\/o timeout|timeout|connection refused/i.test(m)) return 'registry unreachable';
  if (/InvalidImageName|invalid reference/i.test(m)) return 'invalid image name';
  return 'cannot be pulled';
}

/** `exceeded quota: gpu-quota, requested: x=1, used: x=0, limited: x=0` → the readable part. */
export function quotaRefusal(message: string | undefined): string | undefined {
  const m = /exceeded quota:\s*([^,]+)(?:,\s*requested:\s*([^,]+))?(?:,\s*used:\s*([^,]+))?(?:,\s*limited:\s*(.+))?/.exec(message ?? '');
  if (!m) return undefined;
  const [, quota, requested, , limited] = m;
  const name = quota!.trim();
  const [reqKey, reqValue] = (requested ?? '').trim().split('=');
  const [limKey, limValue] = (limited ?? '').trim().split('=');
  if (reqKey && limKey && reqKey === limKey && reqValue !== undefined && limValue !== undefined) {
    return `quota ${name} caps ${limKey} at ${limValue}, the pod asks for ${reqValue}`;
  }
  if (requested && limited) return `quota ${name} allows ${limited.trim()}, the pod asks for ${requested.trim()}`;
  return `quota ${name} exceeded`;
}

/** First sentence of a controller message, without kubelet's pod-uid noise. */
function firstSentence(message: string): string {
  const cleaned = message.replace(/\s*pod=[^\s)]+\([0-9a-f-]{36}\)/g, '').trim();
  return cleaned.split(/\.(\s|$)/)[0]!.trim() || cleaned;
}

function podsPrefix(cause: WorkloadIssueCause): string {
  const n = cause.pods ?? 0;
  if (n > 1) return `${n} pods`;
  return cause.source?.kind === 'Pod' ? cause.source.name : 'pod';
}

export function describeCause(cause: WorkloadIssueCause): IssueReason {
  const { reason, message } = cause;
  if (PULL.has(reason)) {
    const why = pullFailure(message);
    return { status: reason, detail: cause.image ? `${cause.image}: ${why}` : `image ${why}`, full: message };
  }
  if (reason === 'CrashLoopBackOff') {
    const many = (cause.pods ?? 0) > 1;
    const exit = cause.exitCode !== undefined ? `${many ? 'exit' : 'exits'} with code ${cause.exitCode}` : many ? 'keep crashing' : 'keeps crashing';
    const restarts = cause.restarts ? `, ${cause.restarts} restarts` : '';
    return { status: reason, detail: `${podsPrefix(cause)} ${exit}${restarts}`, full: message };
  }
  if (reason === 'Unschedulable') {
    return { status: 'Pending', detail: message ? describeSchedulerMessage(message).summary : 'no node accepts the pod', full: message };
  }
  if (reason === 'NotReady') {
    return { status: 'NotReady', detail: message ? `${podsPrefix(cause)}: ${firstSentence(message)}` : `${podsPrefix(cause)} failing its readiness probe`, full: message };
  }
  if (reason === 'FailedCreate') {
    return { status: reason, detail: quotaRefusal(message) ?? (message ? firstSentence(message) : undefined), full: message };
  }
  if (reason === 'ProvisioningFailed') {
    const missing = /storageclass[^"]*"([^"]+)" not found/i.exec(message ?? '');
    return { status: reason, detail: missing ? `StorageClass ${missing[1]} does not exist` : message ? firstSentence(message) : undefined, full: message };
  }
  if (cause.exitCode !== undefined && cause.exitCode !== 0) {
    return { status: reason, detail: `${podsPrefix(cause)} exited with code ${cause.exitCode}`, full: message };
  }
  return { status: reason, detail: message ? firstSentence(message) : undefined, full: message };
}

/** Reason for an issue: its concrete cause when known, else the checker's own reason and message. */
export function describeIssue(issue: OverviewWorkloadIssue): IssueReason {
  if (issue.cause) {
    const described = describeCause(issue.cause);
    // A Job's own "BackoffLimitExceeded" is the better headline; its pod adds the exit code.
    if (issue.kind === 'Job' && issue.reason && issue.reason !== 'Unavailable') {
      return { status: issue.reason, detail: described.detail ?? issue.message, full: issue.message ?? described.full };
    }
    return described;
  }
  return { status: issue.reason ?? 'Unhealthy', detail: issue.message ? firstSentence(issue.message) : undefined, full: issue.message };
}

/** "4 ImagePull · 3 CrashLoop · 2 Pending" — failing pods grouped by reason family, largest first. */
export function failingPodBreakdown(reasons: string[]): string {
  const family = (reason: string) =>
    PULL.has(reason) ? 'ImagePull' : reason === 'CrashLoopBackOff' ? 'CrashLoop' : reason.startsWith('CreateContainer') ? 'Config error' : reason;
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(family(reason), (counts.get(family(reason)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n} ${name}`)
    .join(' · ');
}

/** Nothing working is red, anything short of that amber (the server's inventory grading). */
export function issueTone(issue: OverviewWorkloadIssue): 'error' | 'warning' {
  switch (issue.kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
      return (issue.ready ?? 0) === 0 ? 'error' : 'warning';
    case 'Job':
    case 'CronJob':
      return 'error';
    case 'PersistentVolumeClaim':
      return issue.reason === 'Lost' ? 'error' : 'warning';
    case 'ResourceQuota':
      return issue.reason === 'AtQuota' ? 'error' : 'warning';
    default:
      return 'warning';
  }
}
