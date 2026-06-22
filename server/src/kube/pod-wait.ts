import { setTimeout as delay } from 'node:timers/promises';
import type { KubeObject } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { HttpProblem } from '../util/errors.js';

interface ContainerState {
  running?: object;
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode?: number };
}

interface ContainerStatus {
  name: string;
  state?: ContainerState;
}

interface PodStatus {
  phase?: string;
  containerStatuses?: ContainerStatus[];
  ephemeralContainerStatuses?: ContainerStatus[];
}

const FATAL_WAIT_REASONS = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError']);

/**
 * Poll a pod until the given container (regular or ephemeral) is running.
 * Fails fast on terminal pull/config errors so the caller can surface the
 * reason instead of timing out.
 */
export async function waitForContainerRunning(
  handle: ClusterHandle,
  namespace: string,
  pod: string,
  container: string,
  opts: { ephemeral?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const obj = await handle.raw.json<KubeObject>(resourcePath('', 'v1', 'pods', { namespace, name: pod }));
    const status = obj.status as PodStatus | undefined;
    const statuses = opts.ephemeral ? status?.ephemeralContainerStatuses : status?.containerStatuses;
    const cs = statuses?.find((s) => s.name === container);
    if (cs?.state?.running) return;
    if (cs?.state?.terminated) {
      throw new HttpProblem(422, `container ${container} terminated (${cs.state.terminated.reason ?? `exit ${cs.state.terminated.exitCode}`})`);
    }
    const waiting = cs?.state?.waiting;
    if (waiting?.reason && FATAL_WAIT_REASONS.has(waiting.reason)) {
      throw new HttpProblem(422, `container ${container} failed to start: ${waiting.reason}${waiting.message ? ` — ${waiting.message}` : ''}`);
    }
    if (status?.phase === 'Failed' || status?.phase === 'Succeeded') {
      throw new HttpProblem(422, `pod ${pod} is ${status.phase}`);
    }
    if (Date.now() > deadline) {
      throw new HttpProblem(504, `timed out waiting for container ${container} to start${waiting?.reason ? ` (last state: ${waiting.reason})` : ''}`);
    }
    await delay(500);
  }
}
