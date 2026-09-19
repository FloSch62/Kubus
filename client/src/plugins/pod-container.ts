import type { KubeObject } from '@kubus/shared';

/** Resolve against a freshly read Pod. Init containers are log sources, never shell defaults. */
export function resolvePluginContainer(pod: KubeObject, action: 'pod.logs' | 'pod.terminal', requested?: string): string {
  const spec = pod.spec as { containers?: Array<{ name: string }>; initContainers?: Array<{ name: string }> } | undefined;
  const applications = spec?.containers ?? [];
  const allowed = action === 'pod.logs' ? [...applications, ...(spec?.initContainers ?? [])] : applications;
  const annotated = pod.metadata.annotations?.['kubectl.kubernetes.io/default-container'];
  const chosen = requested ?? (applications.some((c) => c.name === annotated) ? annotated : applications[0]?.name);
  if (!chosen || !allowed.some((c) => c.name === chosen)) throw new Error('Container no longer exists or is not available for this action');
  return chosen;
}
