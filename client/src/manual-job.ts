import { dump } from 'js-yaml';
import type { KubeObject } from '@kubus/shared';

/**
 * The Job a manual CronJob trigger creates, built the way kubectl's
 * `create job --from=cronjob/<name>` does: the CronJob's jobTemplate plus a
 * manual-instantiate annotation and a non-controller owner reference so the
 * Job shows up under the CronJob without being adopted by it.
 */
export function manualJobYaml(cronJob: KubeObject): string {
  const template = (cronJob.spec as { jobTemplate?: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: unknown } } | undefined)
    ?.jobTemplate;
  const name = cronJob.metadata.name;
  const manifest = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `${name}-manual-${Math.floor(Date.now() / 1000)}`.slice(0, 63),
      namespace: cronJob.metadata.namespace,
      labels: template?.metadata?.labels,
      annotations: { ...template?.metadata?.annotations, 'cronjob.kubernetes.io/instantiate': 'manual' },
      ownerReferences: cronJob.metadata.uid
        ? [{ apiVersion: 'batch/v1', kind: 'CronJob', name, uid: cronJob.metadata.uid, controller: false }]
        : undefined,
    },
    spec: template?.spec,
  };
  // Round-trip through JSON to drop undefined fields, which js-yaml renders as nulls.
  return dump(JSON.parse(JSON.stringify(manifest)), { noRefs: true, lineWidth: 120 });
}
