import { nanoid } from 'nanoid';
import type { DebugPodRequest, DebugPodResponse, DebugProfile, StopDebugRequest } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { runCommand } from './file-copy.js';
import { waitForContainerRunning } from './pod-wait.js';
import { HttpProblem } from '../util/errors.js';

export const DEFAULT_DEBUG_IMAGE = 'busybox:1.36';

/**
 * Idle loop instead of a bare `sleep 3600`: PID 1 inside a PID namespace
 * ignores signals it has no handler for, even SIGKILL from inside — a plain
 * sleep could never be stopped from the UI. The trap makes TERM work and the
 * stop-file is the fallback; the counter keeps the 1-hour TTL.
 */
const STOP_FILE = '/tmp/.kubus-stop';
const DEBUG_IDLE_COMMAND = ['sh', '-c', `trap "exit 0" TERM INT; i=0; while [ ! -e ${STOP_FILE} ] && [ "$i" -lt 3600 ]; do sleep 1; i=$((i+1)); done`];

/**
 * Security context per kubectl-debug profile. `general` stays unset so the
 * container inherits namespace/PodSecurity defaults; `restricted` matches the
 * PodSecurity restricted policy so debugging works in enforced namespaces.
 */
const PROFILE_SECURITY_CONTEXT: Record<DebugProfile, object | undefined> = {
  general: undefined,
  restricted: { runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
  netadmin: { capabilities: { add: ['NET_ADMIN', 'NET_RAW'] } },
  sysadmin: { privileged: true },
};

/**
 * kubectl-debug equivalent: append an ephemeral container to a running pod
 * (pods/ephemeralcontainers subresource) and wait until it runs, so the
 * caller can exec into it. Ephemeral containers are append-only and
 * immutable — each invocation uses a fresh generated name.
 */
export async function addDebugContainer(handle: ClusterHandle, req: DebugPodRequest): Promise<DebugPodResponse> {
  const containerName = `debug-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const image = req.image?.trim() || DEFAULT_DEBUG_IMAGE;
  if (/\s/.test(image)) throw new HttpProblem(422, 'image must be a reference without whitespace');
  const profile = req.profile ?? 'general';
  if (!(profile in PROFILE_SECURITY_CONTEXT)) throw new HttpProblem(422, `unknown debug profile ${String(profile)}`);
  const patch = {
    spec: {
      ephemeralContainers: [
        {
          name: containerName,
          image,
          command: DEBUG_IDLE_COMMAND,
          stdin: true,
          tty: true,
          targetContainerName: req.target || undefined,
          terminationMessagePolicy: 'File',
          securityContext: PROFILE_SECURITY_CONTEXT[profile],
        },
      ],
    },
  };
  try {
    await handle.raw.json(resourcePath('', 'v1', 'pods', { namespace: req.namespace, name: req.pod, subresource: 'ephemeralcontainers' }), {
      method: 'PATCH',
      headers: { 'content-type': 'application/strategic-merge-patch+json' },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 404) {
      throw new HttpProblem(422, 'this cluster does not support ephemeral containers (requires Kubernetes ≥ 1.23)');
    }
    throw err;
  }
  await waitForContainerRunning(handle, req.namespace, req.pod, containerName, { ephemeral: true });
  return { containerName };
}

/**
 * Stop a running debug container. Ephemeral containers can never be removed
 * from the pod spec, but ending their main process terminates them; the
 * record stays (terminated) until the pod is recreated.
 */
export async function stopDebugContainer(handle: ClusterHandle, req: StopDebugRequest): Promise<void> {
  // The stop mechanism is the idle loop watching for STOP_FILE; a container
  // whose command doesn't watch for it (e.g. a bare `sleep` created before
  // this feature) can't be stopped from here — PID 1 in a PID namespace
  // ignores signals it has no handler for. Detect that and say so honestly.
  const pod = await handle.raw.json<{ spec?: { ephemeralContainers?: Array<{ name: string; command?: string[] }> } }>(
    resourcePath('', 'v1', 'pods', { namespace: req.namespace, name: req.pod }),
  );
  const ec = (pod.spec?.ephemeralContainers ?? []).find((c) => c.name === req.container);
  if (!ec) throw new HttpProblem(404, `debug container ${req.container} not found`);
  if (!(ec.command ?? []).some((part) => part.includes(STOP_FILE))) {
    throw new HttpProblem(422, 'this debug container was created before the stop feature and cannot be stopped from the UI — it exits on its own within an hour');
  }

  // Only drop the stop file — sending TERM to PID 1 from here would tear the
  // container down while this very exec is still inside it, making the stop
  // report a spurious failure. The idle loop notices the file within ~1s.
  const outcome = await runCommand(handle, req.namespace, req.pod, req.container, ['sh', '-c', `touch ${STOP_FILE}`]);
  // 137/143 = our exec was killed by the container exiting — that IS success.
  if (outcome.code !== 0 && outcome.code !== 137 && outcome.code !== 143) {
    throw new HttpProblem(500, outcome.stderr || `stop command exited with code ${outcome.code}`);
  }
}
