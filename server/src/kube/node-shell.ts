import { nanoid } from 'nanoid';
import type { DebugProfile, KubeObject } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { waitForContainerRunning } from './pod-wait.js';
import { PROFILE_SECURITY_CONTEXT } from './debug.js';
import { HttpProblem } from '../util/errors.js';

export const DEBUG_NAMESPACE = 'kubus-debug';
const NODE_SHELL_LABEL = 'kubus.io/node-shell';
const NODE_SHELL_IMAGE = 'docker.io/library/busybox:1.36';

/**
 * Privileged pods are rejected in baseline/restricted namespaces, so node
 * shells run in a dedicated namespace with PodSecurity set to privileged.
 */
async function ensureDebugNamespace(handle: ClusterHandle): Promise<void> {
  try {
    await handle.raw.json(resourcePath('', 'v1', 'namespaces', { name: DEBUG_NAMESPACE }));
    return;
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
  }
  await handle.raw.json(resourcePath('', 'v1', 'namespaces', {}), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: DEBUG_NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'kubus',
          'pod-security.kubernetes.io/enforce': 'privileged',
          'pod-security.kubernetes.io/audit': 'privileged',
          'pod-security.kubernetes.io/warn': 'privileged',
        },
      },
    }),
  });
}

/** Best-effort sweep of finished/orphaned node-shell pods. */
async function gcNodeShellPods(handle: ClusterHandle): Promise<void> {
  try {
    const query = new URLSearchParams({ labelSelector: `${NODE_SHELL_LABEL}=true` });
    const list = await handle.raw.json<{ items?: KubeObject[] }>(resourcePath('', 'v1', 'pods', { namespace: DEBUG_NAMESPACE, query }));
    for (const pod of list.items ?? []) {
      const phase = (pod.status as { phase?: string })?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') {
        await deleteNodeShellPod(handle, pod.metadata.name).catch(() => undefined);
      }
    }
  } catch {
    // namespace may not exist yet
  }
}

function podSuffix(): string {
  return nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
}

interface NodePodWait {
  timeoutMs?: number;
  onWaiting?: (reason: string) => void;
  /** Aborts the startup wait (the terminal went away); the pod is deleted. */
  signal?: AbortSignal;
}

/**
 * Create the pod and wait for its container. A pod that never starts (bad
 * image, abandoned terminal) is deleted right away rather than left to
 * activeDeadlineSeconds.
 */
async function startNodePod(
  handle: ClusterHandle,
  node: string,
  name: string,
  container: string,
  annotations: Record<string, string>,
  spec: object,
  wait: NodePodWait = {},
): Promise<{ namespace: string; pod: string; container: string }> {
  await ensureDebugNamespace(handle);
  void gcNodeShellPods(handle);
  await handle.raw.json(resourcePath('', 'v1', 'pods', { namespace: DEBUG_NAMESPACE }), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: DEBUG_NAMESPACE,
        labels: { [NODE_SHELL_LABEL]: 'true', 'app.kubernetes.io/managed-by': 'kubus' },
        annotations: { 'kubus.io/node': node, ...annotations },
      },
      spec: {
        nodeName: node,
        hostPID: true,
        hostNetwork: true,
        hostIPC: true,
        restartPolicy: 'Never',
        activeDeadlineSeconds: 3600,
        tolerations: [{ operator: 'Exists' }],
        ...spec,
      },
    }),
  });
  try {
    await waitForContainerRunning(handle, DEBUG_NAMESPACE, name, container, wait);
  } catch (err) {
    await deleteNodeShellPod(handle, name).catch(() => undefined);
    throw err;
  }
  return { namespace: DEBUG_NAMESPACE, pod: name, container };
}

/**
 * Start a privileged pod pinned to the node, host namespaces shared. The
 * shell then nsenters into PID 1, i.e. a root shell with the host's own
 * tools. activeDeadlineSeconds caps orphans if cleanup never runs.
 */
export async function createNodeShellPod(handle: ClusterHandle, node: string, signal?: AbortSignal): Promise<{ namespace: string; pod: string; container: string }> {
  return startNodePod(handle, node, `kubus-node-shell-${podSuffix()}`, 'shell', {}, {
    containers: [
      {
        name: 'shell',
        image: NODE_SHELL_IMAGE,
        command: ['sleep', '3600'],
        securityContext: { privileged: true },
      },
    ],
  }, { signal });
}

export const NODE_DEBUG_CONTAINER = 'debugger';
export const NODE_DEBUG_ROOT = '/host';

export interface NodeDebugOptions {
  image: string;
  profile?: DebugProfile;
  /** Reports each new waiting reason (image pull, container creation) while the pod starts. */
  onWaiting?: (reason: string) => void;
  signal?: AbortSignal;
}

/**
 * kubectl-debug-node equivalent: a pod with the chosen image pinned to the
 * node, sharing its PID/network/IPC namespaces, with the node's root
 * filesystem mounted at /host. Unlike the node shell the tools come from the
 * image, and the profile decides how much of the host they may touch.
 */
export async function createNodeDebugPod(handle: ClusterHandle, node: string, opts: NodeDebugOptions): Promise<{ namespace: string; pod: string; container: string }> {
  const image = opts.image.trim();
  if (!image) throw new HttpProblem(422, 'image is required');
  if (/\s/.test(image)) throw new HttpProblem(422, 'image must be a reference without whitespace');
  const profile = opts.profile ?? 'general';
  if (!Object.hasOwn(PROFILE_SECURITY_CONTEXT, profile)) throw new HttpProblem(422, `unknown debug profile ${String(profile)}`);
  // Host namespaces and a hostPath mount are exactly what restricted forbids.
  if (profile === 'restricted') throw new HttpProblem(422, 'the restricted profile cannot debug a node; use general, netadmin or sysadmin');
  const annotations = { 'kubus.io/image': image, 'kubus.io/debug-profile': profile };
  // Debug images run to hundreds of MB; a cold pull easily outlasts the default wait.
  const wait = { timeoutMs: 300_000, onWaiting: opts.onWaiting, signal: opts.signal };
  return startNodePod(handle, node, `kubus-node-debug-${podSuffix()}`, NODE_DEBUG_CONTAINER, annotations, {
    volumes: [{ name: 'host-root', hostPath: { path: '/' } }],
    containers: [
      {
        name: NODE_DEBUG_CONTAINER,
        image,
        command: ['sleep', '3600'],
        terminationMessagePolicy: 'File',
        securityContext: PROFILE_SECURITY_CONTEXT[profile],
        volumeMounts: [{ name: 'host-root', mountPath: NODE_DEBUG_ROOT }],
      },
    ],
  }, wait);
}

export async function deleteNodeShellPod(handle: ClusterHandle, pod: string): Promise<void> {
  const query = new URLSearchParams({ gracePeriodSeconds: '0' });
  await handle.raw.json(resourcePath('', 'v1', 'pods', { namespace: DEBUG_NAMESPACE, name: pod, query }), { method: 'DELETE' });
}

/** nsenter into the host's PID 1 namespaces — a root shell on the node. */
export const NODE_SHELL_COMMAND = ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'];

/** Login shell inside the debug image, like a pod shell (debug images set up helpers in /etc/profile.d). */
export const NODE_DEBUG_COMMAND = ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l'];
