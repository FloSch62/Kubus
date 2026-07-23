/* oxlint-disable typescript/unbound-method -- this test intentionally inspects a mocked registry method. */
import Fastify from 'fastify';
import type { KubeObject, ResourceKindInfo } from '@kubus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../server/src/app';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { registerGraphRoutes } from '../../../server/src/routes/graph';
import { HttpProblem } from '../../../server/src/util/errors';

function object(
  kind: string,
  name: string,
  namespace: string | undefined,
  spec: Record<string, unknown> = {},
  status: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): KubeObject {
  return {
    apiVersion: kind === 'Pod' || kind === 'Service' || kind === 'Node' ? 'v1' : 'apps/v1',
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}), uid: `uid-${kind}-${name}` },
    spec,
    status,
    ...extra,
  };
}

const fixtures: Record<string, KubeObject[]> = {
  ingresses: [
    object(
      'Ingress',
      'public',
      'team-a',
      {
        defaultBackend: { service: { name: 'web' } },
        rules: [
          { http: { paths: [{ backend: { service: { name: 'web', port: { number: 80 } } } }] } },
          { http: { paths: [{ backend: { service: { name: 'missing', port: { name: 'http' } } } }] } },
        ],
      },
      { state: 'progressing' },
    ),
  ],
  services: [
    object('Service', 'web', 'team-a', { selector: { app: 'web' }, type: 'ClusterIP' }),
    object('Service', 'empty', 'team-a', { selector: { app: 'none' }, type: 'LoadBalancer' }),
    object('Service', 'headless', 'team-a', {}),
  ],
  deployments: [
    object('Deployment', 'web', 'team-a', { replicas: 2 }, { readyReplicas: 2 }),
    object('Deployment', 'api', 'team-a', { replicas: 3 }, { availableReplicas: 1 }),
  ],
  statefulsets: [object('StatefulSet', 'db', 'team-a', {}, { availableReplicas: 1 })],
  daemonsets: [
    object('DaemonSet', 'node-helper', 'team-a', {}, { desiredNumberScheduled: 2, numberReady: 2 }),
    object('DaemonSet', 'broken-helper', 'team-a', {}, { desiredNumberScheduled: 2, numberReady: 1 }),
  ],
  cronjobs: [object('CronJob', 'nightly', 'team-a', {}, { operationalState: 'active' })],
  jobs: [
    object('Job', 'failed-job', 'team-a', {}, { failed: 2 }),
    object('Job', 'done-job', 'team-a', {}, { succeeded: 1 }),
    object('Job', 'active-job', 'team-a', {}, { active: 1 }),
  ],
  replicasets: [
    object('ReplicaSet', 'web-abc', 'team-a', { replicas: 2 }, { readyReplicas: 2 }, {
      metadata: {
        name: 'web-abc',
        namespace: 'team-a',
        uid: 'uid-rs-web',
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'uid-Deployment-web', controller: true }],
      },
    }),
  ],
  pods: [
    object(
      'Pod',
      'web-1',
      'team-a',
      {
        nodeName: 'node-a',
        volumes: [
          { persistentVolumeClaim: { claimName: 'data' } },
          { configMap: { name: 'web-config' } },
          { secret: { secretName: 'web-secret' } },
        ],
      },
      { phase: 'Running' },
      {
        metadata: {
          name: 'web-1',
          namespace: 'team-a',
          uid: 'uid-pod-web-1',
          labels: { app: 'web', 'app.kubernetes.io/instance': 'demo' },
          ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-abc', uid: 'uid-rs-web', controller: true }],
        },
      },
    ),
    object(
      'Pod',
      'web-2',
      'team-a',
      {
        nodeName: 'missing-node',
        volumes: [
          { persistentVolumeClaim: { claimName: 'missing-pvc' } },
          { configMap: { name: 'missing-config' } },
          { secret: { secretName: 'missing-secret' } },
        ],
      },
      { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] },
      { metadata: { name: 'web-2', namespace: 'team-a', uid: 'uid-pod-web-2', labels: { app: 'web' } } },
    ),
    object('Pod', 'crashing', 'team-a', {}, { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] }),
    object('Pod', 'failed', 'team-b', {}, { phase: 'Failed', reason: 'Evicted' }),
    object('Pod', 'unknown', 'team-a', {}, { phase: 'Unknown' }),
  ],
  configmaps: [object('ConfigMap', 'web-config', 'team-a')],
  secrets: [object('Secret', 'web-secret', 'team-a')],
  persistentvolumeclaims: [
    object('PersistentVolumeClaim', 'data', 'team-a', { volumeName: 'pv-data' }, { phase: 'Bound' }),
    object('PersistentVolumeClaim', 'lost', 'team-a', { volumeName: 'missing-pv' }, { phase: 'Lost' }),
    object('PersistentVolumeClaim', 'pending', 'team-a', {}, { phase: 'Pending' }),
  ],
  persistentvolumes: [
    object('PersistentVolume', 'pv-data', undefined, {}, { phase: 'Bound' }),
    object('PersistentVolume', 'pv-failed', undefined, {}, { phase: 'Failed' }),
    object('PersistentVolume', 'pv-pending', undefined, {}, { phase: 'Pending' }),
  ],
  nodes: [
    object('Node', 'node-a', undefined, {}, { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.32.0' } }),
    object('Node', 'node-b', undefined, {}, { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletDown' }] }),
    object('Node', 'node-c', undefined),
  ],
};

function pluralFromPath(path: string): string | undefined {
  return Object.keys(fixtures).find((plural) => path.includes(`/${plural}`));
}

describe('topology graph routes', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  let app: ReturnType<typeof Fastify>;
  let rawJson: ReturnType<typeof vi.fn>;
  let getResources: ReturnType<typeof vi.fn>;
  let watcherItems: KubeObject[] | undefined;
  let handle: ClusterHandle;

  beforeEach(async () => {
    watcherItems = undefined;
    rawJson = vi.fn(async (path: string) => {
      const plural = pluralFromPath(path);
      return { items: plural ? fixtures[plural] : [] };
    });
    getResources = vi.fn(async () => []);
    handle = {
      contextName: 'dev',
      raw: { json: rawJson },
      discovery: { getResources },
      watchers: {
        peek: vi.fn((_group: string, _version: string, plural: string) =>
          plural === 'pods' && watcherItems
            ? { currentState: () => 'live', items: () => watcherItems }
            : plural === 'services'
              ? { currentState: () => 'reconnecting', items: () => [] }
              : undefined,
        ),
      },
    } as unknown as ClusterHandle;
    const clusters = {
      get: vi.fn((ctx: string) => {
        if (ctx === 'bad') throw new HttpProblem(409, 'not connected', 'NotConnected');
        return handle;
      }),
    };
    app = Fastify();
    apps.push(app);
    registerGraphRoutes(app, { clusters } as unknown as AppContext);
    await app.ready();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((instance) => instance.close()));
  });

  it('builds ownership, routing, selector, scheduling, mount, and volume relationships', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/contexts/dev/graph' });
    expect(response.statusCode).toBe(200);
    const graph = response.json();

    expect(graph.nodes.length).toBeGreaterThan(25);
    expect(graph.edges.map((edge: { kind: string }) => edge.kind)).toEqual(
      expect.arrayContaining(['owns', 'selects', 'routes', 'schedules', 'mounts', 'binds']),
    );
    expect(graph.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('selector matches 0 pods'),
        expect.stringContaining('missing Service missing'),
        expect.stringContaining('missing PVC missing-pvc'),
        expect.stringContaining('missing ConfigMap missing-config'),
        expect.stringContaining('missing Secret missing-secret'),
        expect.stringContaining('missing PV missing-pv'),
      ]),
    );
    const status = (kind: string, name: string) =>
      graph.nodes.find((node: { ref: { kind: string; name: string } }) => node.ref.kind === kind && node.ref.name === name);
    expect(status('Pod', 'web-1')).toMatchObject({ status: 'success', sublabel: 'team-a · app demo' });
    expect(status('Pod', 'crashing')).toMatchObject({ status: 'error', reason: 'CrashLoopBackOff' });
    expect(status('Pod', 'failed')).toMatchObject({ status: 'error', reason: 'Evicted' });
    expect(status('Deployment', 'api')).toMatchObject({ status: 'warning', reason: '1/3 ready' });
    expect(status('Job', 'done-job')).toMatchObject({ status: 'success' });
    expect(status('Node', 'node-b')).toMatchObject({ status: 'error', reason: 'KubeletDown' });
    expect(status('PersistentVolumeClaim', 'lost')).toMatchObject({ status: 'error' });
  });

  it('uses a live watcher cache, filters namespaces, and focuses the graph by depth', async () => {
    watcherItems = fixtures.pods;
    const response = await app.inject({
      method: 'GET',
      url: '/api/contexts/dev/graph?namespace=team-a,team-b&focusGroup=&focusVersion=v1&focusPlural=pods&focusKind=Pod&focusNamespace=team-a&focusName=web-1&depth=4',
    });
    const graph = response.json();
    expect(response.statusCode).toBe(200);
    expect(graph.nodes.some((node: { ref: { name: string } }) => node.ref.name === 'web-1')).toBe(true);
    expect(graph.nodes.length).toBeLessThan(Object.values(fixtures).flat().length);
    expect((handle.watchers.peek as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(rawJson.mock.calls.some(([path]) => String(path).includes('/pods?'))).toBe(false);
  });

  it('discovers dynamically related custom resources around a custom focus', async () => {
    const customKinds: ResourceKindInfo[] = [
      { group: 'example.io', version: 'v1alpha1', plural: 'routers', kind: 'Router', namespaced: true, verbs: ['list'] },
      { group: 'example.io', version: 'v1', plural: 'routers', kind: 'Router', namespaced: true, verbs: ['list'] },
      { group: 'example.io', version: 'v1beta2', plural: 'peers', kind: 'Peer', namespaced: true, verbs: ['list'] },
      { group: 'example.io', version: 'v2alpha1', plural: 'pools', kind: 'ResourcePool', namespaced: true, verbs: ['list'] },
      { group: 'example.io', version: 'v1', plural: 'monitors', kind: 'HealthMonitor', namespaced: true, verbs: ['list'] },
      { group: 'example.io', version: 'not-semver', plural: 'routers', kind: 'Router', namespaced: true, verbs: ['list'] },
      { group: 'example.io', version: 'v1', plural: 'ignored', kind: 'Ignored', namespaced: true, verbs: ['get'] },
      { group: 'example.io', version: 'v1', plural: 'widgets', kind: 'Widget', namespaced: true, verbs: ['list'] },
    ].map((kind) => ({ ...kind, custom: true }));
    getResources.mockResolvedValue(customKinds);
    rawJson.mockImplementation(async (path: string) => {
      if (path.includes('/widgets/widget-a')) {
        return object(
          'Widget',
          'widget-a',
          'team-a',
          {
            displayName: 'router-a',
            routerRef: 'router-a',
            peerSelector: 'role=peer',
            targetPools: ['pool-a'],
            endpoint: 'https://ignored.example.test',
            empty: '',
          },
          { state: 'running' },
          { metadata: { name: 'widget-a', namespace: 'team-a', uid: 'uid-widget', labels: { app: 'widget' }, annotations: { router: 'router-a' } } },
        );
      }
      if (path.includes('/routers')) {
        return {
          items: [
            object('Router', 'router-a', 'team-a', { widgetName: 'widget-a' }, { state: 'down' }),
            object('Router', 'router-a', 'team-b', { widgetName: 'widget-a' }, { state: 'down' }),
          ],
        };
      }
      if (path.includes('/peers')) {
        return {
          items: [
            object('Peer', 'peer-a', 'team-a', {}, { phase: 'pending' }, {
              metadata: { name: 'peer-a', namespace: 'team-a', uid: 'uid-peer', labels: { role: 'peer' }, annotations: { owner: 'widget-a' } },
            }),
          ],
        };
      }
      if (path.includes('/pools')) return { items: [object('ResourcePool', 'pool-a', 'team-a', {}, { conditions: [{ type: 'Ready', status: 'False', message: 'warming' }] })] };
      if (path.includes('/monitors')) {
        return {
          items: [
            object('HealthMonitor', 'monitor-a', 'team-a', {}, { conditions: [{ type: 'Ready', status: 'True' }] }, {
              metadata: { name: 'monitor-a', namespace: 'team-a', uid: 'uid-monitor', labels: { 'example.io/widget': 'widget-a' } },
            }),
          ],
        };
      }
      const plural = pluralFromPath(path);
      return { items: plural ? fixtures[plural] : [] };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/contexts/dev/graph?focusGroup=example.io&focusVersion=v1&focusPlural=widgets&focusKind=Widget&focusNamespace=team-a&focusName=widget-a&depth=2',
    });
    const graph = response.json();
    expect(response.statusCode).toBe(200);
    const node = (kind: string) => graph.nodes.find((candidate: { ref: { kind: string } }) => candidate.ref.kind === kind);
    const relations = (targetKind: string) =>
      graph.edges.filter((edge: { source: string; target: string }) => edge.source === node('Widget').id && edge.target === node(targetKind).id);
    expect(node('Widget')).toMatchObject({ status: 'success', layer: 'other' });
    expect(relations('Router')).toEqual([expect.objectContaining({ kind: 'manages', label: 'spec.routerRef' })]);
    expect(relations('Peer')).toEqual([expect.objectContaining({ kind: 'selects', label: 'spec.peerSelector' })]);
    expect(relations('ResourcePool')).toEqual([expect.objectContaining({ kind: 'manages', label: 'spec.targetPools' })]);
    expect(relations('HealthMonitor')).toEqual([expect.objectContaining({ kind: 'manages', label: 'metadata' })]);
    expect(graph.edges.map((edge: { kind: string }) => edge.kind)).toEqual(expect.arrayContaining(['manages', 'selects']));
  });

  it('reports missing focused data, list failures, and disconnected contexts', async () => {
    rawJson.mockImplementation(async (path: string) => {
      if (path.includes('/widgets/missing')) throw new Error('widget unavailable');
      if (path.includes('/services')) throw 'service unavailable';
      return { items: [] };
    });
    getResources.mockResolvedValue([]);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/contexts/dev/graph?focusGroup=example.io&focusVersion=v1&focusPlural=widgets&focusKind=Widget&focusNamespace=team-a&focusName=missing',
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ nodes: [], edges: [] });
    expect(missing.json().warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('widget unavailable'), expect.stringContaining('service unavailable'), expect.stringContaining('No topology data found')]),
    );

    const bad = await app.inject({ method: 'GET', url: '/api/contexts/bad/graph' });
    expect(bad.statusCode).toBe(409);
  });
});
