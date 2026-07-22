import { Fragment } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GridColDef } from '@mui/x-data-grid';
import type { KubeObject, MetricsSnapshot, PrinterColumn } from '@kubus/shared';
import type { ClusterRow } from '../../../client/src/api/queries';
import {
  buildColumns,
  buildCrdColumns,
  crdHiddenFields,
  makeMetricsLookup,
  makeNodeAllocationLookup,
  makeWorkloadMetricsLookup,
} from '../../../client/src/components/columns';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

const ALL_COLUMN_IDS = [
  'labels',
  'name',
  'namespace',
  'cluster',
  'age',
  'ready',
  'podStatus',
  'restarts',
  'node',
  'cpu',
  'memory',
  'nodePods',
  'nodeCpuUsage',
  'nodeMemoryUsage',
  'nodeCpuAllocation',
  'nodeMemoryAllocation',
  'workloadReady',
  'upToDate',
  'available',
  'dsDesired',
  'dsReady',
  'jobStatus',
  'jobCompletions',
  'jobDuration',
  'jobOwner',
  'cronSchedule',
  'cronNextRun',
  'cronSuspend',
  'cronLastSchedule',
  'svcType',
  'svcClusterIP',
  'svcLoadBalancerIP',
  'svcPorts',
  'ingressClass',
  'ingressHosts',
  'dataKeys',
  'secretType',
  'pvcStatus',
  'pvcCapacity',
  'pvcStorageClass',
  'pvCapacity',
  'pvStatus',
  'pvClaim',
  'nodeStatus',
  'nodeRoles',
  'nodeVersion',
  'nodeOperatingSystem',
  'nodeKernelVersion',
  'nodeContainerRuntime',
  'nodeInternalIp',
  'nodeExternalIp',
  'nodeTaints',
  'nodeConditions',
  'nodeProviderID',
  'crdKind',
  'crdGroup',
  'crdScope',
  'crdVersions',
  'crdStatus',
  'nsStatus',
  'eventType',
  'eventReason',
  'eventObject',
  'eventMessage',
  'eventCount',
  'eventLastSeen',
  'hpaTarget',
  'hpaMinMax',
  'hpaReplicas',
  'hpaConditions',
] as const;

function richObject(name = 'demo'): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'team-a',
      uid: `uid-${name}`,
      creationTimestamp: '2024-01-01T00:00:00.000Z',
      labels: {
        app: 'web',
        tier: 'frontend',
        empty: '',
        'node-role.kubernetes.io/control-plane': '',
      },
      ownerReferences: [
        { apiVersion: 'batch/v1', kind: 'Job', name: 'nightly-123', uid: 'owner-1', controller: true },
      ],
    },
    data: { first: 'one', second: 'two' },
    spec: {
      nodeName: 'node-a',
      containers: [
        {
          name: 'app',
          resources: { requests: { cpu: '250m', memory: '128Mi' } },
        },
      ],
      schedule: '*/5 * * * *',
      timeZone: 'UTC',
      suspend: false,
      type: 'LoadBalancer',
      clusterIP: '10.96.0.20',
      ports: [{ port: 443, targetPort: 8443, protocol: 'TCP', nodePort: 30443 }],
      ingressClassName: 'nginx',
      rules: [{ host: 'app.example.test' }],
      storageClassName: 'fast',
      capacity: { storage: '20Gi' },
      claimRef: { namespace: 'team-a', name: 'claim-a' },
      providerID: 'kind://docker/node-a',
      taints: [{ key: 'dedicated', value: 'infra', effect: 'NoSchedule' }],
      names: { kind: 'Widget' },
      group: 'example.test',
      scope: 'Namespaced',
      versions: [
        { name: 'v1', served: true, storage: true },
        { name: 'v1beta1', served: true, storage: false },
      ],
      scaleTargetRef: { kind: 'Deployment', name: 'web' },
      minReplicas: 2,
      maxReplicas: 8,
    },
    status: {
      phase: 'Running',
      containerStatuses: [{ name: 'app', ready: true, restartCount: 3, state: { running: {} } }],
      ephemeralContainerStatuses: [{ name: 'debugger', ready: true, state: { running: {} } }],
      updatedReplicas: 2,
      availableReplicas: 2,
      readyReplicas: 2,
      replicas: 3,
      desiredNumberScheduled: 3,
      numberReady: 2,
      succeeded: 1,
      active: 1,
      startTime: '2024-01-01T00:00:00.000Z',
      completionTime: '2024-01-01T00:01:00.000Z',
      lastScheduleTime: '2024-01-01T00:00:00.000Z',
      currentReplicas: 3,
      allocatable: { cpu: '4', memory: '8Gi', pods: '110' },
      capacity: { storage: '10Gi' },
      addresses: [
        { type: 'InternalIP', address: '10.0.0.2' },
        { type: 'ExternalIP', address: '203.0.113.2' },
      ],
      nodeInfo: {
        kubeletVersion: 'v1.32.0',
        osImage: 'Linux',
        kernelVersion: '6.8.0',
        containerRuntimeVersion: 'containerd://2.0',
      },
      conditions: [
        { type: 'Ready', status: 'True' },
        { type: 'AbleToScale', status: 'False', reason: 'Backoff', message: 'waiting for metrics' },
        { type: 'Established', status: 'True' },
      ],
      loadBalancer: { ingress: [{ ip: '203.0.113.10' }] },
    },
    involvedObject: { kind: 'Pod', namespace: 'team-a', name },
    reason: 'Started',
    message: 'Container started',
    count: 4,
    type: 'Warning',
    lastTimestamp: '2024-01-01T00:00:00.000Z',
  };
}

function row(obj: KubeObject, ctx = 'dev'): ClusterRow {
  return { ctx, obj };
}

function callGetter(column: GridColDef<ClusterRow>, target: ClusterRow): unknown {
  const getter = column.valueGetter as
    | ((value: unknown, row: ClusterRow, definition: GridColDef<ClusterRow>, api: unknown) => unknown)
    | undefined;
  return getter?.(undefined, target, column, {});
}

function renderCells(columns: GridColDef<ClusterRow>[], target: ClusterRow) {
  const cells = columns.flatMap((column) => {
    if (!column.renderCell) return [];
    const value = callGetter(column, target);
    const rendered = column.renderCell({ row: target, value, field: column.field } as never);
    return [
      <div key={column.field} data-testid={`cell-${column.field}`}>
        {rendered}
      </div>,
    ];
  });
  return render(<Fragment>{cells}</Fragment>);
}

afterEach(() => {
  useUiPrefsStore.setState({ cronHumanSchedule: false });
});

describe('resource table columns', () => {
  it('builds, evaluates, and renders every built-in column', () => {
    const onLabelClick = vi.fn();
    const metrics = vi.fn(() => ({
      cpuMilli: 500,
      memBytes: 256 * 1024 * 1024,
      cpuCapacityMilli: 1_000,
      memCapacityBytes: 512 * 1024 * 1024,
    }));
    const nodeAllocation = vi.fn(() => ({
      podCount: 12,
      daemonSetPodCount: 2,
      cpuRequestMilli: 2_000,
      memoryRequestBytes: 4 * 1024 * 1024 * 1024,
    }));
    const target = row(richObject());
    const columns = buildColumns([...ALL_COLUMN_IDS, 'missing'], {
      multiCluster: true,
      metrics,
      nodeAllocation,
      onLabelClick,
    });

    expect(columns).toHaveLength(ALL_COLUMN_IDS.length);
    expect(columns.map((column) => column.field)).toEqual(ALL_COLUMN_IDS);
    const values = Object.fromEntries(columns.map((column) => [column.field, callGetter(column, target)]));
    expect(values).toMatchObject({
      name: 'demo',
      namespace: 'team-a',
      cluster: 'dev',
      restarts: 3,
      node: 'node-a',
      svcClusterIP: '10.96.0.20',
      ingressClass: 'nginx',
      dataKeys: 2,
      secretType: 'Warning',
      hpaTarget: 'Deployment/web',
      hpaMinMax: '2/8',
      hpaReplicas: '3',
    });

    renderCells(columns, target);
    expect(screen.getByTestId('cell-nodePods')).toHaveTextContent('12 (2 ds)');
    expect(screen.getByTestId('cell-podStatus')).toHaveTextContent('Running');
    expect(screen.getByTestId('cell-hpaConditions')).toHaveTextContent('Backoff');
    fireEvent.click(screen.getByText('app=web'));
    expect(onLabelClick).toHaveBeenCalledWith('app=web');
    fireEvent.click(screen.getByText('*/5 * * * *'));
    expect(useUiPrefsStore.getState().cronHumanSchedule).toBe(true);
    expect(metrics).toHaveBeenCalled();
    expect(nodeAllocation).toHaveBeenCalled();
  });

  it('handles sparse rows, hidden cluster columns, and missing live metrics', () => {
    const sparse = row({ metadata: { name: 'empty', uid: 'empty' }, spec: {}, status: {} });
    const columns = buildColumns(ALL_COLUMN_IDS.slice(), { multiCluster: false });

    expect(columns.some((column) => column.field === 'cluster')).toBe(false);
    for (const column of columns) expect(() => callGetter(column, sparse)).not.toThrow();
    renderCells(columns, sparse);
    expect(screen.getByTestId('cell-cpu')).toHaveTextContent('—');
    expect(screen.getByTestId('cell-memory')).toHaveTextContent('—');
    expect(screen.getByTestId('cell-labels')).toHaveTextContent('—');
    expect(screen.getByTestId('cell-cronNextRun')).toHaveTextContent('—');
    expect(screen.getByTestId('cell-hpaConditions')).toHaveTextContent('—');
  });
});

describe('column lookup helpers', () => {
  it('aggregates active pod requests per node and ignores terminal or unscheduled pods', () => {
    const running = richObject('running');
    running.metadata.ownerReferences = [
      { apiVersion: 'apps/v1', kind: 'DaemonSet', name: 'node-helper', uid: 'ds', controller: true },
    ];
    const second = richObject('second');
    const done = richObject('done');
    done.status = { phase: 'Succeeded' };
    const unscheduled = richObject('unscheduled');
    unscheduled.spec = { containers: [] };

    const lookup = makeNodeAllocationLookup([row(running), row(second), row(done), row(unscheduled)]);
    expect(lookup('dev', 'node-a')).toEqual({
      podCount: 2,
      daemonSetPodCount: 1,
      cpuRequestMilli: 500,
      memoryRequestBytes: 256 * 1024 * 1024,
    });
    expect(lookup('dev', 'missing')).toEqual({
      podCount: 0,
      daemonSetPodCount: 0,
      cpuRequestMilli: 0,
      memoryRequestBytes: 0,
    });
  });

  it('indexes pod and node metrics and rejects unavailable or unsupported snapshots', () => {
    const snapshots = new Map<string, MetricsSnapshot>([
      [
        'dev',
        {
          available: true,
          probed: true,
          items: [
            { name: 'demo', namespace: 'team-a', cpuMilli: 25, memBytes: 100 },
            { name: 'node-a', cpuMilli: 500, memBytes: 1_000, cpuCapacityMilli: 4_000, memCapacityBytes: 8_000 },
          ],
        },
      ],
      ['down', { available: false, probed: true, items: [] }],
    ]);

    const pods = makeMetricsLookup('Pod', snapshots);
    const nodes = makeMetricsLookup('Node', snapshots);
    expect(pods?.('dev', 'team-a', 'demo')).toMatchObject({ cpuMilli: 25, memBytes: 100 });
    expect(pods?.('dev', 'other', 'demo')).toBeUndefined();
    expect(nodes?.('dev', undefined, 'node-a')).toMatchObject({ cpuCapacityMilli: 4_000 });
    expect(nodes?.('down', undefined, 'node-a')).toBeUndefined();
    expect(makeMetricsLookup('Service', snapshots)).toBeUndefined();
    expect(makeMetricsLookup('Pod', undefined)).toBeUndefined();
  });

  it('rolls pod usage and requests up to each supported workload owner', () => {
    const deploymentPod = richObject('web-pod');
    deploymentPod.metadata.labels = { 'pod-template-hash': 'abc123' };
    deploymentPod.metadata.ownerReferences = [
      { apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-abc123', uid: 'rs', controller: true },
    ];
    const statefulPod = richObject('db-0');
    statefulPod.metadata.ownerReferences = [
      { apiVersion: 'apps/v1', kind: 'StatefulSet', name: 'db', uid: 'sts', controller: true },
    ];
    const snapshots = new Map<string, MetricsSnapshot>([
      [
        'dev',
        {
          available: true,
          probed: true,
          items: [
            { name: 'web-pod', namespace: 'team-a', cpuMilli: 100, memBytes: 200 },
            { name: 'db-0', namespace: 'team-a', cpuMilli: 300, memBytes: 400 },
          ],
        },
      ],
    ]);

    const deployments = makeWorkloadMetricsLookup('Deployment', [row(deploymentPod), row(statefulPod)], snapshots);
    const statefulSets = makeWorkloadMetricsLookup('StatefulSet', [row(deploymentPod), row(statefulPod)], snapshots);
    expect(deployments?.('dev', 'team-a', 'web')).toMatchObject({ cpuMilli: 100, memBytes: 200, cpuCapacityMilli: 250 });
    expect(statefulSets?.('dev', 'team-a', 'db')).toMatchObject({ cpuMilli: 300, memBytes: 400 });
    expect(deployments?.('dev', 'team-a', 'missing')).toBeUndefined();
    expect(makeWorkloadMetricsLookup('Service', [], snapshots)).toBeUndefined();
    expect(makeWorkloadMetricsLookup('Deployment', [], undefined)).toBeUndefined();
  });

  it('builds CRD printer columns for scalar, object, status, date, and missing values', () => {
    const specs: PrinterColumn[] = [
      { name: 'Ready', type: 'string', jsonPath: '.status.phase', description: 'current phase' },
      { name: 'Created', type: 'date', jsonPath: '.metadata.creationTimestamp' },
      { name: 'Replicas', type: 'integer', jsonPath: '.status.replicas' },
      { name: 'Config', type: 'string', jsonPath: '.spec.config', priority: 1 },
      { name: 'Missing', type: 'number', jsonPath: '.status.missing', priority: 2 },
      { name: 'Enabled', type: 'boolean', jsonPath: '.spec.enabled' },
    ];
    const object = richObject();
    object.spec = { ...object.spec, config: { mode: 'safe' }, enabled: true };
    object.status = { ...object.status, replicas: '3' };
    const target = row(object);
    const columns = buildCrdColumns(specs);

    expect(columns.map((column) => callGetter(column, target))).toEqual([
      'Running',
      '2024-01-01T00:00:00.000Z',
      3,
      '{"mode":"safe"}',
      null,
      'true',
    ]);
    expect(crdHiddenFields(specs)).toEqual(['crd_3_Config', 'crd_4_Missing']);
    renderCells(columns, target);
    expect(screen.getByTestId('cell-crd_0_Ready')).toHaveTextContent('Running');
    expect(screen.getByTestId('cell-crd_1_Created')).not.toBeEmptyDOMElement();
  });
});
