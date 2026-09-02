import { describe, expect, it, vi } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager.js';
import { listReleaseResources } from '../../../server/src/helm/release-resources.js';

const payload = vi.hoisted(() => ({
  manifest: [
    'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2',
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: web',
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config',
    'apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: web-reader\n  namespace: ignored',
    'apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: gadget',
    'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-canary',
  ].join('\n---\n'),
  hooks: [{ name: 'migrate', kind: 'Job', path: 'templates/migrate.yaml', manifest: 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: migrate', events: ['pre-upgrade'] }],
}));

vi.mock('../../../server/src/helm/release-reader.js', () => ({
  getLatestPayload: vi.fn(async () => payload),
}));

function handle(requests: string[]): ClusterHandle {
  const deployments = {
    currentState: () => 'live',
    items: () => [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'web', namespace: 'shop', uid: 'dep-1', creationTimestamp: '2026-08-01T00:00:00Z', generation: 3 },
        spec: { replicas: 2 },
        status: { observedGeneration: 3, replicas: 2, updatedReplicas: 2, availableReplicas: 2, readyReplicas: 2 },
      },
    ],
  };
  return {
    discovery: {
      getResources: async () => [
        { group: 'apps', version: 'v1', kind: 'Deployment', plural: 'deployments', namespaced: true },
        { group: '', version: 'v1', kind: 'Service', plural: 'services', namespaced: true },
        { group: '', version: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true },
        { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true },
        { group: 'rbac.authorization.k8s.io', version: 'v1', kind: 'ClusterRole', plural: 'clusterroles', namespaced: false },
        { group: 'batch', version: 'v1', kind: 'Job', plural: 'jobs', namespaced: true },
      ],
    },
    watchers: {
      peek: (group: string, _version: string, plural: string) => (group === 'apps' && plural === 'deployments' ? deployments : undefined),
    },
    raw: {
      json: async (path: string) => {
        requests.push(path);
        if (path.endsWith('/services/web')) return { metadata: { name: 'web', namespace: 'shop', uid: 'svc-1', creationTimestamp: '2026-08-01T00:00:01Z' } };
        if (path.endsWith('/configmaps/web-config')) throw Object.assign(new Error('not found'), { code: 404 });
        if (path.endsWith('/clusterroles/web-reader')) return { metadata: { name: 'web-reader', uid: 'cr-1' } };
        if (path.endsWith('/pods/web-canary')) {
          return { metadata: { name: 'web-canary', namespace: 'shop', uid: 'pod-1' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } };
        }
        if (path.endsWith('/jobs/migrate')) throw Object.assign(new Error('jobs is forbidden'), { code: 403 });
        throw new Error(`unexpected request ${path}`);
      },
    },
  } as unknown as ClusterHandle;
}

describe('listReleaseResources', () => {
  it('resolves manifest and hook objects against the cluster in manifest order', async () => {
    const requests: string[] = [];
    const resources = await listReleaseResources(handle(requests), 'shop', 'web');

    expect(resources.map((resource) => [resource.kind, resource.name, resource.namespace, resource.state])).toEqual([
      ['Deployment', 'web', 'shop', 'ready'],
      ['Service', 'web', 'shop', 'present'],
      ['ConfigMap', 'web-config', 'shop', 'missing'],
      ['ClusterRole', 'web-reader', undefined, 'present'],
      ['Widget', 'gadget', 'shop', 'unknown'],
      ['Pod', 'web-canary', 'shop', 'progressing'],
      ['Job', 'migrate', 'shop', 'unknown'],
    ]);

    // The pinned Deployment watcher answered from its live cache.
    expect(requests.some((path) => path.includes('/deployments/'))).toBe(false);
    expect(requests).toContain('/api/v1/namespaces/shop/services/web');
    expect(requests).toContain('/apis/rbac.authorization.k8s.io/v1/clusterroles/web-reader');

    const [deployment, , configMap, clusterRole, widget, pod, job] = resources;
    expect(deployment).toMatchObject({ group: 'apps', version: 'v1', plural: 'deployments', uid: 'dep-1', createdAt: '2026-08-01T00:00:00Z', message: '2/2 available, 2/2 updated, 2/2 total' });
    expect(configMap?.message).toBe('Not found in the cluster.');
    expect(clusterRole).toMatchObject({ namespaced: false, plural: 'clusterroles' });
    expect(widget).toMatchObject({ plural: '', message: 'example.com/v1 Widget is not served by this cluster' });
    expect(pod?.message).toContain('pod phase is Running');
    expect(job).toMatchObject({ hookEvents: ['pre-upgrade'], message: 'jobs is forbidden' });
  });

  it('marks a hook object that is gone as not present rather than missing', async () => {
    const requests: string[] = [];
    const base = handle(requests);
    const raw = base.raw as unknown as { json: (path: string) => Promise<unknown> };
    const original = raw.json;
    raw.json = async (path: string) => {
      if (path.endsWith('/jobs/migrate')) throw Object.assign(new Error('not found'), { code: 404 });
      return original(path);
    };
    const resources = await listReleaseResources(base, 'shop', 'web');
    const job = resources.find((resource) => resource.kind === 'Job');
    expect(job).toMatchObject({ state: 'missing', message: 'Hook object is not present; its delete policy may have removed it after running.' });
  });
});
