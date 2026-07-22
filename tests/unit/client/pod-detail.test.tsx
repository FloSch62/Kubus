import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject, PodEnvResponse } from '@kubus/shared';
import { PodDetail } from '../../../client/src/components/detail/PodDetail';
import { useDetailStore } from '../../../client/src/state/detail';
import { useDockStore } from '../../../client/src/state/dock';

const queries = vi.hoisted(() => ({
  metrics: undefined as Map<string, unknown> | undefined,
  env: undefined as PodEnvResponse | undefined,
  envLoading: false,
  envSelections: [] as Array<Record<string, unknown>>,
  events: undefined as { items: KubeObject[] } | undefined,
  stopPending: false,
  stopFails: false,
  stopMutate: vi.fn(),
}));

const effects = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useResourceMetrics: () => ({ data: queries.metrics }),
  usePodEnv: (selection: Record<string, unknown>) => {
    queries.envSelections.push(selection);
    return { data: queries.env, isLoading: queries.envLoading };
  },
  useStopDebug: () => ({ isPending: queries.stopPending, mutate: queries.stopMutate }),
  useResourceEvents: () => ({ data: queries.events }),
}));

vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
vi.mock('../../../client/src/components/PortForwardDialog.js', () => ({
  PortForwardDialog: ({ initialRemotePort, onClose }: { initialRemotePort?: number; onClose: () => void }) => (
    <div>
      Forward {initialRemotePort}
      <button onClick={onClose}>Close forward</button>
    </div>
  ),
}));

function event(name: string, type: string, timestamp: string, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name, uid: `uid-${name}`, creationTimestamp: timestamp },
    type,
    ...extra,
  } as KubeObject;
}

function richPod(): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'web-0',
      namespace: 'team-a',
      uid: 'pod-uid',
      creationTimestamp: '2026-07-22T10:00:00Z',
      labels: { app: 'web' },
      annotations: { docs: 'https://example.com/help' },
    },
    spec: {
      nodeName: 'node-a',
      serviceAccountName: 'workload-sa',
      containers: [
        {
          name: 'app',
          image: 'example/app:v1',
          ports: [
            { containerPort: 8080, protocol: 'TCP', name: 'http' },
            { containerPort: 5353, protocol: 'UDP', name: 'dns' },
          ],
          volumeMounts: [
            { name: 'config', mountPath: '/etc/config', readOnly: true, subPath: 'app.conf' },
            { name: 'scratch', mountPath: '/tmp' },
          ],
          resources: {
            requests: { cpu: '100m', memory: '64Mi', 'ephemeral-storage': '1Mi' },
            limits: { cpu: '500m', memory: '128Mi', 'ephemeral-storage': '2Mi' },
          },
          readinessProbe: { httpGet: { scheme: 'HTTPS', path: '/ready', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 3, timeoutSeconds: 2, failureThreshold: 4 },
          livenessProbe: { tcpSocket: { port: 'http' } },
          startupProbe: { grpc: { port: 9090, service: 'health' } },
        },
        {
          name: 'worker',
          image: 'example/worker:v1',
          volumeMounts: [{ name: 'secret', mountPath: '/run/secret' }],
          readinessProbe: { exec: { command: ['test', '-f', '/tmp/ready'] } },
          livenessProbe: {},
        },
      ],
      initContainers: [
        {
          name: 'mesh',
          image: 'mesh:v1',
          restartPolicy: 'Always',
          startupProbe: { grpc: { port: 15021 } },
        },
        {
          name: 'migrate',
          image: 'migrate:v1',
          readinessProbe: { httpGet: {} },
        },
      ],
      ephemeralContainers: [
        { name: 'debug-live', image: 'busybox', targetContainerName: 'app' },
        { name: 'debug-done', image: 'busybox', targetContainerName: 'worker' },
        { name: 'debug-wait', image: 'busybox' },
        { name: 'debug-unknown' },
      ],
      volumes: [
        { name: 'claim', persistentVolumeClaim: { claimName: 'data-pvc' } },
        { name: 'config', configMap: { name: 'app-config' } },
        { name: 'secret', secret: { secretName: 'app-secret' } },
        { name: 'host', hostPath: { path: '/var/lib/app' } },
        { name: 'image-volume', image: { reference: 'example/data:v1', pullPolicy: 'IfNotPresent' } },
        { name: 'scratch', emptyDir: {} },
        { name: 'mystery' },
      ],
      nodeSelector: { zone: 'west' },
      tolerations: [
        { key: 'dedicated', operator: 'Equal', value: 'web', effect: 'NoSchedule', tolerationSeconds: 30 },
        {},
      ],
    },
    status: {
      phase: 'Pending',
      reason: 'SchedulingGated',
      message: 'Waiting for capacity',
      podIP: '10.0.0.7',
      qosClass: 'Burstable',
      conditions: [
        { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
        { type: 'ContainersReady', status: 'False' },
        { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'No matching nodes' },
        { type: 'Initialized', status: 'Unknown' },
      ],
      containerStatuses: [
        {
          name: 'app',
          ready: true,
          started: false,
          restartCount: 2,
          state: { running: {} },
          lastState: { terminated: { reason: 'Error', finishedAt: '2026-07-22T09:55:00Z' } },
        },
        {
          name: 'worker',
          ready: false,
          started: true,
          state: { waiting: { reason: 'CrashLoopBackOff', message: 'backing off' } },
        },
      ],
      initContainerStatuses: [
        { name: 'mesh', ready: false, started: true, state: { waiting: { message: 'starting' } } },
        { name: 'migrate', ready: false, state: { terminated: { reason: 'Completed' } } },
        { name: 'failed-init', state: { terminated: { reason: 'Error', exitCode: 2, message: 'migration failed' } } },
      ],
      ephemeralContainerStatuses: [
        { name: 'debug-live', state: { running: { startedAt: '2026-07-22T09:59:00Z' } } },
        { name: 'debug-done', state: { terminated: { reason: 'Completed', startedAt: '2026-07-22T09:00:00Z', finishedAt: '2026-07-22T09:30:00Z' } } },
        { name: 'debug-wait', state: { waiting: { reason: 'ImagePullBackOff' } } },
      ],
    },
  } as KubeObject;
}

beforeEach(() => {
  queries.metrics = new Map([
    [
      'dev',
      {
        available: true,
        items: [
          { namespace: 'other', name: 'web-0', containers: [] },
          {
            namespace: 'team-a',
            name: 'web-0',
            containers: [
              { name: 'app', cpuMilli: 25, memBytes: 16 * 1024 * 1024 },
              { name: 'mesh', cpuMilli: 5, memBytes: 4 * 1024 * 1024 },
            ],
          },
        ],
      },
    ],
  ]);
  queries.env = {
    containers: [
      {
        name: 'app',
        env: [
          { name: 'DUP', value: 'old', source: { type: 'literal' } },
          { name: 'DUP', value: 'new', source: { type: 'fieldRef', key: 'metadata.name' } },
          { name: 'CPU', value: '1', source: { type: 'resourceFieldRef', key: 'limits.cpu' } },
          { name: 'PASSWORD', value: '••••', redacted: true, source: { type: 'secretKeyRef', ref: 'app-secret', key: 'password' } },
          { name: 'TOKEN', value: '••••', redacted: true, source: { type: 'secretKeyRef', ref: 'app-secret', key: 'TOKEN' } },
          { name: 'CONFIG', value: 'yes', source: { type: 'configMapKeyRef', ref: 'app-config', key: 'feature' } },
          { name: 'BROKEN', error: 'missing key', source: { type: 'configMapRef', ref: 'missing-config' } },
        ],
      },
      {
        name: 'migrate',
        init: true,
        env: [
          { name: 'ALL_SECRET', value: '••••', redacted: true, source: { type: 'secretRef', ref: 'all-secrets' } },
          { name: 'ALL_CONFIG', value: 'ok', source: { type: 'configMapRef', ref: 'all-config' } },
        ],
      },
      { name: 'empty', env: [] },
    ],
  };
  queries.envLoading = false;
  queries.envSelections = [];
  queries.events = {
    items: [
      event('normal', 'Normal', '2026-07-22T09:59:00Z', { reason: 'Pulling', message: 'Pulling image' }),
      event('warning-old', 'Warning', '2026-07-22T09:30:00Z', { reason: 'FailedMount', message: 'Mount failed' }),
      event('warning-new', 'Warning', '2026-07-22T10:00:00Z', { reason: 'FailedScheduling', message: 'No nodes', count: 3 }),
    ],
  };
  queries.stopPending = false;
  queries.stopFails = false;
  queries.stopMutate.mockReset();
  queries.stopMutate.mockImplementation((_value, options: { onSuccess: () => void; onError: (error: unknown) => void }) => {
    if (queries.stopFails) options.onError(new Error('stop denied'));
    else options.onSuccess();
  });
  effects.toast.mockClear();
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, pendingDiscard: undefined });
  useDockStore.setState({ tabs: [], activeId: undefined, open: false, maximized: false });
});

describe('PodDetail', () => {
  it('renders live diagnostics, probes, environment, volumes, scheduling, and debug controls', () => {
    render(<PodDetail obj={richPod()} ctx="dev" />);

    expect(screen.getByText('Why this pod isn’t ready')).toBeInTheDocument();
    expect(screen.getByText(/Pod: SchedulingGated/)).toBeInTheDocument();
    expect(screen.getByText(/PodScheduled: Unschedulable/)).toBeInTheDocument();
    expect(screen.getByText(/worker: CrashLoopBackOff/)).toBeInTheDocument();
    expect(screen.getByText(/FailedScheduling ×3/)).toBeInTheDocument();
    expect(screen.getByText('Init containers')).toBeInTheDocument();
    expect(screen.getByText('Debug containers')).toBeInTheDocument();
    expect(screen.getByText('Probes')).toBeInTheDocument();
    expect(screen.getByText('Environment')).toBeInTheDocument();
    expect(screen.getByText('Volumes')).toBeInTheDocument();
    expect(screen.getByText('Scheduling')).toBeInTheDocument();
    expect(screen.getByText('HTTPS /ready :8080')).toBeInTheDocument();
    expect(screen.getByText('TCP :http')).toBeInTheDocument();
    expect(screen.getByText('gRPC :9090 health')).toBeInTheDocument();
    expect(screen.getByText('exec test -f /tmp/ready')).toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Node node-a'));
    fireEvent.click(screen.getByText('SA workload-sa'));
    fireEvent.click(screen.getByRole('button', { name: 'configmap/app-config → feature' }));
    fireEvent.click(screen.getByRole('button', { name: 'persistentVolumeClaim/data-pvc' }));
    expect(useDetailStore.getState().stack.map((selection) => selection.kind)).toEqual([
      'Node',
      'ServiceAccount',
      'ConfigMap',
      'PersistentVolumeClaim',
    ]);

    fireEvent.click(screen.getByRole('switch', { name: 'Reveal secret values' }));
    expect(queries.envSelections.at(-1)).toMatchObject({ reveal: true });

    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    expect(useDockStore.getState().tabs[0]).toMatchObject({ kind: 'terminal', container: 'debug-live' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(effects.toast).toHaveBeenCalledWith('success', expect.stringContaining('Stopping debug-live'));

    fireEvent.click(screen.getByText('8080 · http/TCP'));
    expect(screen.getByText('Forward 8080')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close forward' }));
    expect(screen.queryByText('Forward 8080')).not.toBeInTheDocument();
  }, 15_000);

  it('handles unavailable metrics, loading and empty environment data, and stop failures', () => {
    queries.metrics = new Map([['dev', { available: false, items: [] }]]);
    queries.env = { containers: [] };
    queries.envLoading = true;
    queries.events = { items: [event('normal', 'Normal', '2026-07-22T10:00:00Z', { reason: 'Pulling' })] };
    queries.stopFails = true;
    const view = render(<PodDetail obj={richPod()} ctx="dev" />);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText('Pulling')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(effects.toast).toHaveBeenCalledWith('error', 'stop denied');

    view.unmount();
    queries.envLoading = false;
    render(<PodDetail obj={richPod()} ctx="dev" />);
    expect(screen.queryByText('Environment')).not.toBeInTheDocument();
  });

  it('omits live-only and empty sections for a completed minimal pod', () => {
    queries.metrics = undefined;
    queries.env = { containers: [] };
    const pod: KubeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'done', uid: 'done', labels: {}, annotations: {} },
      spec: { containers: [{ name: 'main', ports: [{ containerPort: 8080 }] }] },
      status: { phase: 'Succeeded', containerStatuses: [{ name: 'main', state: { terminated: {} } }] },
    } as KubeObject;

    render(<PodDetail obj={pod} ctx="dev" />);
    expect(screen.queryByText('Why this pod isn’t ready')).not.toBeInTheDocument();
    expect(screen.queryByText('Init containers')).not.toBeInTheDocument();
    expect(screen.queryByText('Environment')).not.toBeInTheDocument();
    expect(screen.queryByText('Volumes')).not.toBeInTheDocument();
    expect(screen.queryByText('Scheduling')).not.toBeInTheDocument();
    expect(screen.queryByText('Conditions')).not.toBeInTheDocument();
    expect(screen.getByText('8080/TCP')).not.toHaveAttribute('role', 'button');
  });
});
