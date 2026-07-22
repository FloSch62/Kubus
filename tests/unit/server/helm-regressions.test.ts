import { expect, it } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager.js';
import { createDocIfAbsent, docKey, manifestDocs } from '../../../server/src/helm/common.js';
import { workloadState } from '../../../server/src/helm/readiness.js';
import { compareVersionsDesc } from '../../../server/src/helm/repo.js';

const crd = {
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: 'widgets.example.com' },
};

interface RecordedRequest {
  path: string;
  init: { method?: string; body?: string };
}

function crdHandle(status: number, requests: RecordedRequest[]): ClusterHandle {
  return {
    discovery: {
      getResources: async () => [
        {
          group: 'apiextensions.k8s.io',
          version: 'v1',
          kind: 'CustomResourceDefinition',
          plural: 'customresourcedefinitions',
          namespaced: false,
        },
      ],
    },
    raw: {
      request: async (path: string, init: RecordedRequest['init']) => {
        requests.push({ path, init });
        return new Response('{}', { status });
      },
    },
  } as unknown as ClusterHandle;
}

it('chart CRD creation leaves an existing cluster-wide CRD unchanged', async () => {
  const requests: RecordedRequest[] = [];
  const created = await createDocIfAbsent(crdHandle(409, requests), structuredClone(crd));

  expect(created).toBe(false);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe('/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
  expect(requests[0]?.init.method).toBe('POST');
  expect(requests[0]?.path.includes('force=true')).toBe(false);
});

it('chart CRD creation reports a newly created CRD', async () => {
  const requests: RecordedRequest[] = [];
  const created = await createDocIfAbsent(crdHandle(201, requests), structuredClone(crd));

  expect(created).toBe(true);
  expect(JSON.parse(requests[0]?.init.body ?? '{}').metadata.name).toBe(crd.metadata.name);
});

it('OnDelete StatefulSets are ready when every desired replica is ready', () => {
  const state = workloadState('StatefulSet', {
    metadata: { generation: 3 },
    spec: { replicas: 2, updateStrategy: { type: 'OnDelete' } },
    status: { observedGeneration: 3, readyReplicas: 2, updatedReplicas: 0 },
  });

  expect(state.ready).toBe(true);
});

it('RollingUpdate StatefulSets still wait for updated replicas', () => {
  const state = workloadState('StatefulSet', {
    metadata: { generation: 3 },
    spec: { replicas: 2, updateStrategy: { type: 'RollingUpdate' } },
    status: { observedGeneration: 3, readyReplicas: 2, updatedReplicas: 0 },
  });

  expect(state.ready).toBe(false);
});

it('SemVer pre-release identifiers use numeric and ASCII precedence', () => {
  const ascending = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];

  expect(ascending.toSorted(compareVersionsDesc)).toEqual(ascending.toReversed());
  expect(['1.0.0-beta.2', '1.0.0-beta.10'].toSorted(compareVersionsDesc)).toEqual([
    '1.0.0-beta.10',
    '1.0.0-beta.2',
  ]);
  expect(compareVersionsDesc('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
});

it('prune matching ignores apiVersion so migrations keep the upgraded object', () => {
  const oldDoc = {
    apiVersion: 'policy/v1beta1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'pdb', namespace: 'ns' },
  };
  const newDoc = {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'pdb', namespace: 'ns' },
  };

  expect(docKey(oldDoc)).toBe(docKey(newDoc));
});

it('cluster-scoped resources kept across revisions are never pruned', () => {
  const manifest = [
    '---',
    'apiVersion: rbac.authorization.k8s.io/v1',
    'kind: ClusterRole',
    'metadata:',
    '  name: app-role',
    '---',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: app',
    '',
  ].join('\n');
  const newDocs = manifestDocs(manifest, 'app-ns');
  // Upgrade/rollback capture keys before applying…
  const newKeys = new Set(newDocs.map(docKey));
  // …because applyDoc strips the stamped namespace from cluster-scoped docs in place.
  for (const doc of newDocs) {
    if (doc.kind === 'ClusterRole') delete doc.metadata?.namespace;
  }
  const pruneDocs = manifestDocs(manifest, 'app-ns').filter((doc) => !newKeys.has(docKey(doc)));

  expect(pruneDocs).toEqual([]);
});

it('partitioned StatefulSet rolling updates only wait for unpartitioned pods', () => {
  const state = workloadState('StatefulSet', {
    metadata: { generation: 4 },
    spec: {
      replicas: 5,
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 3 } },
    },
    status: { observedGeneration: 4, readyReplicas: 5, updatedReplicas: 2 },
  });

  expect(state.ready).toBe(true);
});

it('paused Deployments fail fast instead of burning the readiness timeout', () => {
  const state = workloadState('Deployment', {
    metadata: { generation: 2 },
    spec: { replicas: 1, paused: true },
    status: { observedGeneration: 2 },
  });

  expect(state.ready).toBe(false);
  expect(state.failed).toBe(true);
});
