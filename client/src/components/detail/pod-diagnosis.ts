import type { KubeObject } from '@kubus/shared';
import { formatBytes, formatCpu } from '../format.js';
import { podRequestTotals } from '../../kube-display.js';
import type { ContainerStateDetail, ContainerStatus } from './container-spec.js';
import { describeSchedulerMessage, parseSchedulerMessage } from './scheduling.js';

/**
 * Plain-language answers to "why isn't this pod running", built from the
 * container states and the scheduler's condition. Kubernetes reports the
 * facts in its own vocabulary (CrashLoopBackOff, a kubelet message with the
 * pod UID in it); this turns them into one sentence a person reads first,
 * with the original message kept for reference. Pure, so the pod banner and
 * the workload banners share one reading.
 */

export type DiagnosisKind = 'crashloop' | 'exited' | 'image' | 'config' | 'start' | 'unschedulable';

export interface Diagnosis {
  kind: DiagnosisKind;
  /** The container it is about; undefined for pod-level (scheduling) answers. */
  container?: string;
  init?: boolean;
  /** One sentence: "Container api exits with code 1 about 5 s after starting". */
  headline: string;
  /** What Kubernetes does about it: restarts, back-off, retry. */
  detail?: string;
  /** The kubelet's or scheduler's own message, kept for reference. */
  raw?: string;
  rawLabel?: string;
  /** Which log holds the output before the failure: the crashed instance ('previous') or the stopped one ('current'). */
  logs?: 'previous' | 'current';
  /** When the failing run ended (lastState/state terminated). */
  finishedAt?: string;
  exitCode?: number;
  severity: 'error' | 'warning';
}

/** "5m0s" / "40s" / "1h2m3s" (Go durations in kubelet messages) → seconds. */
export function parseGoDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Seconds as words for sentences: "5 minutes", "40 seconds", "2 minutes 30 seconds". */
export function spokenDuration(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(Math.round(seconds), 'second');
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${unit(m, 'minute')} ${unit(s, 'second')}` : unit(m, 'minute');
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(h, 'hour');
}

/** How long a run lasted, rounded for a sentence: "about 5 s", "about 3 min". */
export function approxRunTime(startedAt: string | undefined, finishedAt: string | undefined): { seconds: number; text: string } | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const s = ms / 1000;
  if (s < 1) return { seconds: s, text: 'less than a second' };
  if (s < 90) return { seconds: s, text: `about ${Math.round(s)} s` };
  if (s < 5400) return { seconds: s, text: `about ${Math.round(s / 60)} min` };
  return { seconds: s, text: `about ${Math.round(s / 3600)} h` };
}

function firstClause(message: string, max = 140): string {
  const line = message.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The image an image-pull message names: `pulling image "repo/app:1.2"`. */
export function imageInMessage(message: string | undefined): string | undefined {
  return message ? /image "([^"]+)"/i.exec(message)?.[1] : undefined;
}

/** Why an image cannot be pulled, in words, read from the runtime's error chain. */
export function pullFailureCause(message: string | undefined, reason?: string): string | undefined {
  if (reason === 'ErrImageNeverPull') return 'it is not on the node and the pull policy is Never';
  if (reason === 'InvalidImageName') return 'the image name is not valid';
  if (!message) return undefined;
  if (/no such host|server misbehaving|name resolution|Temporary failure in name resolution/i.test(message)) return 'registry host not found';
  if (/x509|certificate signed by unknown|tls: /i.test(message)) return 'the registry’s TLS certificate is not trusted';
  if (/toomanyrequests|rate limit/i.test(message)) return 'the registry’s pull rate limit was hit';
  if (/unauthorized|authentication required|pull access denied|denied|forbidden|\b40[13]\b/i.test(message)) return 'access denied (missing or wrong pull credentials)';
  if (/manifest unknown|: not found|not found:|\b404\b|NotFound/i.test(message)) return 'image or tag not found';
  if (/connection refused/i.test(message)) return 'the registry refused the connection';
  if (/i\/o timeout|timed? ?out|deadline exceeded|connection reset/i.test(message)) return 'the registry did not respond';
  if (/invalid reference format|couldn't parse image/i.test(message)) return 'the image name is not valid';
  return undefined;
}

/** CreateContainerConfigError, said as the missing piece: "ConfigMap app-config does not exist". */
export function configFailureCause(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const missing = /\b(configmap|secret)s? "([^"]+)" not found/i.exec(message);
  if (missing) return `${missing[1]!.toLowerCase() === 'secret' ? 'Secret' : 'ConfigMap'} ${missing[2]} does not exist`;
  const key = /couldn't find key (\S+) in (ConfigMap|Secret) (?:[^/\s]+\/)?(\S+)/i.exec(message);
  if (key) return `key ${key[1]} is missing from ${key[2]} ${key[3]}`;
  if (/runAsNonRoot and image will run as root/i.test(message)) return 'the image runs as root but the pod requires a non-root user';
  return firstClause(message);
}

/** Why the runtime could not start the process: "command app is not in the image". */
export function startFailureCause(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const exec = /exec: "([^"]+)": executable file not found/i.exec(message);
  if (exec) return `command ${exec[1]} is not in the image`;
  if (/no such file or directory/i.test(message)) return 'a path in its command or mounts does not exist';
  if (/permission denied/i.test(message)) return 'permission denied starting its command';
  return firstClause(message);
}

/** What happened to a run that ended, from its exit code and reason. */
function exitPhrase(name: string, t: ContainerStateDetail, run: string | undefined, past: boolean): string {
  const code = t.exitCode;
  const after = run ? (run === 'less than a second' ? 'right after starting' : `${run} after starting`) : undefined;
  const verb = (present: string, pastTense: string) => (past ? pastTense : present);
  if (t.reason === 'OOMKilled') {
    return `Container ${name} ${verb('runs', 'ran')} out of memory and ${verb('is', 'was')} killed${after ? ` ${after}` : ''}`;
  }
  if (code === 0) return `Container ${name} ${verb('stops', 'stopped')}${after ? ` ${after}` : ''} with exit code 0 and ${verb('is', 'was')} restarted`;
  if (code === 137) return `Container ${name} ${verb('is', 'was')} killed (exit 137, SIGKILL)${after ? ` ${after}` : ''}`;
  if (code === 143) return `Container ${name} ${verb('is', 'was')} stopped (exit 143, SIGTERM)${after ? ` ${after}` : ''}`;
  if (code === 139) return `Container ${name} ${verb('crashes', 'crashed')} with a segmentation fault (exit 139)${after ? ` ${after}` : ''}`;
  if (code === 127) return `Container ${name} cannot find its command (exit 127)`;
  if (code === 126) return `Container ${name} cannot run its command (exit 126)`;
  if (code !== undefined) return `Container ${name} ${verb('exits', 'exited')} with code ${code}${after ? ` ${after}` : ''}`;
  return `Container ${name} ${verb('keeps crashing', 'crashed')}`;
}

function exitNote(t: ContainerStateDetail | undefined): string | undefined {
  if (!t) return undefined;
  if (t.reason === 'OOMKilled') return 'It used more memory than its limit allows.';
  if (t.exitCode === 137) return 'Exit 137 usually means a failed liveness probe or the node’s out-of-memory killer.';
  return undefined;
}

function restartsSentence(restarts: number): string {
  if (restarts === 1) return 'It has restarted once.';
  return `It has restarted ${restarts} times.`;
}

/**
 * The answer for one container, or undefined when its state needs none
 * (running, completed, still being created).
 */
export function diagnoseContainer(
  cs: ContainerStatus,
  opts: { init?: boolean; restartPolicy?: string; image?: string; hint?: string } = {},
): Diagnosis | undefined {
  const name = cs.name;
  const waiting = cs.state?.waiting;
  const terminated = cs.state?.terminated;
  const base = { container: name, init: opts.init };
  if (waiting?.reason === 'CrashLoopBackOff') {
    const last = cs.lastState?.terminated;
    const run = approxRunTime(last?.startedAt, last?.finishedAt);
    const backoff = /back-off (\S+)/i.exec(waiting.message ?? '')?.[1];
    const backoffSeconds = backoff ? parseGoDuration(backoff) : undefined;
    const waitText =
      backoffSeconds !== undefined
        ? `Kubernetes now waits up to ${spokenDuration(backoffSeconds)} between attempts (CrashLoopBackOff).`
        : 'Kubernetes waits longer before each new attempt (CrashLoopBackOff).';
    return {
      ...base,
      kind: 'crashloop',
      headline: last ? exitPhrase(name, last, run?.text, false) : `Container ${name} keeps crashing`,
      detail: [exitNote(last), restartsSentence(cs.restartCount ?? 0), waitText].filter(Boolean).join(' '),
      raw: waiting.message,
      logs: 'previous',
      finishedAt: last?.finishedAt,
      exitCode: last?.exitCode,
      severity: 'error',
    };
  }
  if (waiting && /^(ImagePullBackOff|ErrImagePull|InvalidImageName|ErrImageNeverPull|ImageInspectError)$/.test(waiting.reason ?? '')) {
    const image = imageInMessage(waiting.message) ?? opts.image;
    const cause = pullFailureCause(waiting.message, waiting.reason) ?? pullFailureCause(opts.hint);
    return {
      ...base,
      kind: 'image',
      headline: `Image ${image ?? `of container ${name}`} cannot be pulled${cause ? `: ${cause}` : ''}`,
      detail:
        waiting.reason === 'InvalidImageName' || waiting.reason === 'ErrImageNeverPull'
          ? `Container ${name} cannot start until the image reference is fixed.`
          : `Container ${name} cannot start. Kubernetes keeps retrying the pull with a growing delay (${waiting.reason}).`,
      raw: waiting.message ?? opts.hint,
      severity: 'error',
    };
  }
  if (waiting?.reason === 'CreateContainerConfigError') {
    const cause = configFailureCause(waiting.message);
    return {
      ...base,
      kind: 'config',
      headline: `Container ${name} cannot start${cause ? `: ${cause}` : ''}`,
      detail: 'Kubernetes retries once the missing configuration exists.',
      raw: waiting.message,
      severity: 'error',
    };
  }
  if (waiting && /^(CreateContainerError|RunContainerError|StartError|ContainerCannotRun)$/.test(waiting.reason ?? '')) {
    const cause = startFailureCause(waiting.message);
    return {
      ...base,
      kind: 'start',
      headline: `Container ${name} could not be started${cause ? `: ${cause}` : ''}`,
      raw: waiting.message,
      severity: 'error',
    };
  }
  if (terminated && terminated.exitCode !== undefined && terminated.exitCode !== 0) {
    if (terminated.reason === 'StartError' || terminated.reason === 'ContainerCannotRun') {
      const cause = startFailureCause(terminated.message);
      return { ...base, kind: 'start', headline: `Container ${name} could not be started${cause ? `: ${cause}` : ''}`, raw: terminated.message, severity: 'error' };
    }
    const run = approxRunTime(terminated.startedAt, terminated.finishedAt);
    const policy = opts.restartPolicy;
    // Between two attempts of a crash loop the container sits terminated
    // for a moment before the back-off starts; it is the same loop.
    if (policy !== 'Never' && (cs.restartCount ?? 0) > 0) {
      return {
        ...base,
        kind: 'crashloop',
        headline: exitPhrase(name, terminated, run?.text, false),
        detail: [exitNote(terminated), restartsSentence(cs.restartCount ?? 0), 'Kubernetes restarts it after a growing delay (CrashLoopBackOff).'].filter(Boolean).join(' '),
        raw: terminated.message,
        logs: 'current',
        finishedAt: terminated.finishedAt,
        exitCode: terminated.exitCode,
        severity: 'error',
      };
    }
    return {
      ...base,
      kind: 'exited',
      headline: exitPhrase(name, terminated, run?.text, true),
      detail: [
        exitNote(terminated),
        policy === 'Never' ? 'The pod’s restart policy is Never, so it stays stopped.' : undefined,
      ]
        .filter(Boolean)
        .join(' ') || undefined,
      raw: terminated.message,
      logs: 'current',
      finishedAt: terminated.finishedAt,
      exitCode: terminated.exitCode,
      severity: 'error',
    };
  }
  return undefined;
}

interface PodShape {
  phase?: string;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
}

/** No node takes the pod: the scheduler's verdict in one line, plus what the pod asks for. */
export function diagnoseScheduling(pod: KubeObject): Diagnosis | undefined {
  const status = pod.status as PodShape | undefined;
  if (status?.phase !== 'Pending') return undefined;
  const cond = status.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
  if (!cond?.message || cond.reason === 'SchedulingGated') return undefined;
  const { short } = describeSchedulerMessage(cond.message);
  const available = parseSchedulerMessage(cond.message).available?.split('/');
  const requests = podRequestTotals(pod);
  const asks: string[] = [];
  if (/Insufficient cpu/i.test(cond.message) && requests.cpuMilli) asks.push(`${formatCpu(requests.cpuMilli)} of CPU`);
  if (/Insufficient memory/i.test(cond.message) && requests.memoryBytes) asks.push(`${formatBytes(requests.memoryBytes)} of memory`);
  return {
    kind: 'unschedulable',
    headline: `No node can run this pod: ${short}`,
    detail:
      [
        available ? `${available[0]} of ${available[1]} node${available[1] === '1' ? '' : 's'} can take it.` : undefined,
        asks.length ? `The pod requests ${asks.join(' and ')}.` : undefined,
      ]
        .filter(Boolean)
        .join(' ') || undefined,
    raw: cond.message,
    rawLabel: 'Scheduler message',
    severity: 'warning',
  };
}

interface PodDiagnosisShape {
  containerStatuses?: ContainerStatus[];
  initContainerStatuses?: ContainerStatus[];
}

/** Every answer for a pod: its containers (init first), then scheduling. */
export function diagnosePod(pod: KubeObject, hintFor?: (container: string) => string | undefined): Diagnosis[] {
  const status = pod.status as PodDiagnosisShape | undefined;
  const spec = pod.spec as { restartPolicy?: string; containers?: Array<{ name: string; image?: string }>; initContainers?: Array<{ name: string; image?: string }> } | undefined;
  const imageOf = new Map([...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].map((c) => [c.name, c.image]));
  const out: Diagnosis[] = [];
  const phase = (pod.status as { phase?: string } | undefined)?.phase;
  if (phase === 'Succeeded') return out;
  const inits = new Set((status?.initContainerStatuses ?? []).map((c) => c.name));
  for (const cs of [...(status?.initContainerStatuses ?? []), ...(status?.containerStatuses ?? [])]) {
    const d = diagnoseContainer(cs, { init: inits.has(cs.name), restartPolicy: spec?.restartPolicy, image: imageOf.get(cs.name), hint: hintFor?.(cs.name) });
    if (d) out.push(d);
  }
  const scheduling = diagnoseScheduling(pod);
  if (scheduling) out.push(scheduling);
  return out;
}

/** A container's command line for a one-line caption: `sh -c "echo hi; sleep 5"`. */
export function commandSummary(command: string[] | undefined, args: string[] | undefined, max = 70): string | undefined {
  const parts = [...(command ?? []), ...(args ?? [])];
  if (!parts.length) return undefined;
  const quote = (p: string) => (!/[\s"'$;&|<>]/.test(p) ? p : p.includes('"') && !p.includes("'") ? `'${p}'` : `"${p.replace(/"/g, '\\"')}"`);
  const text = parts.map(quote).join(' ');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
