import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocIfAbsent, docKey, manifestDocs } from '../dist/helm/common.js';
import { workloadState } from '../dist/helm/readiness.js';
import { compareVersionsDesc } from '../dist/helm/repo.js';

const crd = {
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: 'widgets.example.com' },
};

function crdHandle(status, requests) {
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
      request: async (path, init) => {
        requests.push({ path, init });
        return new Response('{}', { status });
      },
    },
  };
}

void test('chart CRD creation leaves an existing cluster-wide CRD unchanged', async () => {
  const requests = [];
  const created = await createDocIfAbsent(crdHandle(409, requests), structuredClone(crd));

  assert.equal(created, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].path.includes('force=true'), false);
});

void test('chart CRD creation reports a newly created CRD', async () => {
  const requests = [];
  const created = await createDocIfAbsent(crdHandle(201, requests), structuredClone(crd));

  assert.equal(created, true);
  assert.equal(JSON.parse(requests[0].init.body).metadata.name, crd.metadata.name);
});

void test('OnDelete StatefulSets are ready when every desired replica is ready', () => {
  const state = workloadState('StatefulSet', {
    metadata: { generation: 3 },
    spec: { replicas: 2, updateStrategy: { type: 'OnDelete' } },
    status: { observedGeneration: 3, readyReplicas: 2, updatedReplicas: 0 },
  });

  assert.equal(state.ready, true);
});

void test('RollingUpdate StatefulSets still wait for updated replicas', () => {
  const state = workloadState('StatefulSet', {
    metadata: { generation: 3 },
    spec: { replicas: 2, updateStrategy: { type: 'RollingUpdate' } },
    status: { observedGeneration: 3, readyReplicas: 2, updatedReplicas: 0 },
  });

  assert.equal(state.ready, false);
});

void test('SemVer pre-release identifiers use numeric and ASCII precedence', () => {
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

  assert.deepEqual(ascending.toSorted(compareVersionsDesc), ascending.toReversed());
  assert.deepEqual(['1.0.0-beta.2', '1.0.0-beta.10'].toSorted(compareVersionsDesc), [
    '1.0.0-beta.10',
    '1.0.0-beta.2',
  ]);
  assert.equal(compareVersionsDesc('1.0.0+build.1', '1.0.0+build.2'), 0);
});

void test('prune matching ignores apiVersion so migrations keep the upgraded object', () => {
  const oldDoc = { apiVersion: 'policy/v1beta1', kind: 'PodDisruptionBudget', metadata: { name: 'pdb', namespace: 'ns' } };
  const newDoc = { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'pdb', namespace: 'ns' } };

  assert.equal(docKey(oldDoc), docKey(newDoc));
});

void test('cluster-scoped resources kept across revisions are never pruned', () => {
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
    if (doc.kind === 'ClusterRole') delete doc.metadata.namespace;
  }
  const pruneDocs = manifestDocs(manifest, 'app-ns').filter((doc) => !newKeys.has(docKey(doc)));

  assert.deepEqual(pruneDocs, []);
});

void test('partitioned StatefulSet rolling updates only wait for unpartitioned pods', () => {
  const state = workloadState('StatefulSet', {
    metadata: { generation: 4 },
    spec: { replicas: 5, updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 3 } } },
    status: { observedGeneration: 4, readyReplicas: 5, updatedReplicas: 2 },
  });

  assert.equal(state.ready, true);
});

void test('paused Deployments fail fast instead of burning the readiness timeout', () => {
  const state = workloadState('Deployment', {
    metadata: { generation: 2 },
    spec: { replicas: 1, paused: true },
    status: { observedGeneration: 2 },
  });

  assert.equal(state.ready, false);
  assert.equal(state.failed, true);
});
