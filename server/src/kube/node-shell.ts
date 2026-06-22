import { nanoid } from 'nanoid';
import type { KubeObject } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { waitForContainerRunning } from './pod-wait.js';

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

/**
 * Start a privileged pod pinned to the node, host namespaces shared. The
 * shell then nsenters into PID 1, i.e. a root shell with the host's own
 * tools. activeDeadlineSeconds caps orphans if cleanup never runs.
 */
export async function createNodeShellPod(handle: ClusterHandle, node: string): Promise<{ namespace: string; pod: string; container: string }> {
  await ensureDebugNamespace(handle);
  void gcNodeShellPods(handle);
  const name = `kubus-node-shell-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
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
        annotations: { 'kubus.io/node': node },
      },
      spec: {
        nodeName: node,
        hostPID: true,
        hostNetwork: true,
        hostIPC: true,
        restartPolicy: 'Never',
        activeDeadlineSeconds: 3600,
        tolerations: [{ operator: 'Exists' }],
        containers: [
          {
            name: 'shell',
            image: NODE_SHELL_IMAGE,
            command: ['sleep', '3600'],
            securityContext: { privileged: true },
          },
        ],
      },
    }),
  });
  await waitForContainerRunning(handle, DEBUG_NAMESPACE, name, 'shell');
  return { namespace: DEBUG_NAMESPACE, pod: name, container: 'shell' };
}

export async function deleteNodeShellPod(handle: ClusterHandle, pod: string): Promise<void> {
  const query = new URLSearchParams({ gracePeriodSeconds: '0' });
  await handle.raw.json(resourcePath('', 'v1', 'pods', { namespace: DEBUG_NAMESPACE, name: pod, query }), { method: 'DELETE' });
}

/** nsenter into the host's PID 1 namespaces — a root shell on the node. */
export const NODE_SHELL_COMMAND = ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'];
