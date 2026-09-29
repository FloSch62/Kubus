import { fireEvent, render, screen, within } from '@testing-library/react';
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
  useUsedBy: () => ({ data: { items: [], unavailable: [], truncated: 0 }, isLoading: false, isError: false }),
  useResourceMetrics: () => ({ data: queries.metrics }),
  usePodEnv: (selection: Record<string, unknown>) => {
    queries.envSelections.push(selection);
    return { data: queries.env, isLoading: queries.envLoading };
  },
  useStopDebug: () => ({ isPending: queries.stopPending, mutate: queries.stopMutate }),
  useResourceEvents: () => ({ data: queries.events }),
}));

vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
const lastOutput = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown> | undefined>, lines: ['boom: config missing'] }));
vi.mock('../../../client/src/components/detail/last-output.js', () => ({
  useLastOutput: (sel: Record<string, unknown> | undefined) => {
    lastOutput.calls.push(sel);
    return sel ? { status: 'done', lines: lastOutput.lines } : undefined;
  },
}));
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
      priorityClassName: 'high',
      priority: 1000,
      containers: [
        {
          name: 'app',
          image: 'example/app:v1',
          command: ['/bin/app'],
          args: ['--serve'],
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
          lastState: { terminated: { reason: 'Error', exitCode: 137, finishedAt: '2026-07-22T09:55:00Z' } },
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

/** Value tile of the summary strip, addressed by its label (a <dt> has no accessible name of its own). */
const tile = (label: string) => {
  const term = screen.getAllByRole('term').find((el) => el.textContent === label);
  if (!term) throw new Error(`no summary tile labelled ${label}`);
  return term.nextElementSibling;
};

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
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, drafts: {}, pendingDiscard: undefined });
  useDockStore.setState({ tabs: [], activeId: undefined, open: false, maximized: false });
});

describe('PodDetail', () => {
  it('leads with the summary strip and the reasons the pod is not ready', () => {
    render(<PodDetail obj={richPod()} ctx="dev" />);

    // Headline numbers: one ready container of two, two restarts, node and IP.
    expect(tile('Ready')).toHaveTextContent('1/2');
    expect(tile('Restarts')).toHaveTextContent('2');
    expect(screen.getByText('10.0.0.7')).toBeInTheDocument();

    // Failing containers and the scheduler's refusal are said in words; what
    // the diagnosis does not cover stays listed as Kubernetes reports it.
    const banner = screen.getByRole('alert', { name: 'Why this pod isn’t ready' });
    expect(within(banner).getByText('Container failed-init exited with code 2')).toBeInTheDocument();
    expect(within(banner).getByText('Container worker keeps crashing')).toBeInTheDocument();
    expect(within(banner).getByText('No node can run this pod: No matching nodes')).toBeInTheDocument();
    expect(within(banner).getByText(/Pod: SchedulingGated/)).toBeInTheDocument();
    expect(within(banner).getByText(/mesh: Waiting/)).toBeInTheDocument();
    expect(within(banner).getByText('FailedMount')).toBeInTheDocument();
    // Covered by the diagnosis: no repeat of the condition or the scheduler events.
    expect(within(banner).queryByText(/PodScheduled: Unschedulable/)).not.toBeInTheDocument();
    expect(within(banner).queryByText(/FailedScheduling/)).not.toBeInTheDocument();

    expect(screen.getByText('Init containers')).toBeInTheDocument();
    expect(screen.getByText('Debug containers')).toBeInTheDocument();
    expect(screen.getByText('Volumes')).toBeInTheDocument();
    expect(screen.getByText('Scheduling')).toBeInTheDocument();
    expect(screen.getByText('Burstable')).toBeInTheDocument();
    expect(screen.getByText('high (1000)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'node-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'workload-sa' }));
    fireEvent.click(screen.getByRole('button', { name: 'persistentVolumeClaim/data-pvc' }));
    expect(useDetailStore.getState().stack.map((selection) => selection.kind)).toEqual(['Node', 'ServiceAccount', 'PersistentVolumeClaim']);

    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    expect(useDockStore.getState().tabs[0]).toMatchObject({ kind: 'terminal', container: 'debug-live' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(effects.toast).toHaveBeenCalledWith('success', expect.stringContaining('Stopping debug-live'));

    fireEvent.click(screen.getByText('8080 · http/TCP'));
    expect(screen.getByText('Forward 8080')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close forward' }));
    expect(screen.queryByText('Forward 8080')).not.toBeInTheDocument();
  }, 15_000);

  it('keeps each container’s probes, environment, mounts and command inside its panel', () => {
    render(<PodDetail obj={richPod()} ctx="dev" />);

    // The crashlooping container's kubelet message is not repeated on its
    // panel; the banner keeps it one click away. The restart history of the
    // running container still shows its exit code.
    expect(screen.queryByText('backing off')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Kubelet message' })[1]!);
    expect(screen.getAllByText('backing off')).toHaveLength(1);
    expect(screen.getByText(/2 restarts · last Error \(exit 137\)/)).toBeInTheDocument();

    // Nothing is expanded until asked.
    expect(screen.queryByText('HTTPS /ready :8080')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Probes for app' }));
    expect(screen.getByText('HTTPS /ready :8080')).toBeInTheDocument();
    expect(screen.getByText('TCP :http (8080)')).toBeInTheDocument();
    expect(screen.getByText('gRPC :9090 health')).toBeInTheDocument();
    const probes = within(screen.getByText('HTTPS /ready :8080').closest('table')!);
    expect(probes.getByText('Ready')).toBeInTheDocument();
    expect(probes.getByText('Pending')).toBeInTheDocument();

    // One detail at a time per container: opening the environment closes the probes.
    fireEvent.click(screen.getByRole('button', { name: 'Environment for app' }));
    expect(screen.queryByText('HTTPS /ready :8080')).not.toBeInTheDocument();
    expect(screen.getByText('missing key')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'configmap/app-config → feature' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'ConfigMap', name: 'app-config' });
    fireEvent.click(screen.getByRole('switch', { name: 'Reveal secret values' }));
    expect(queries.envSelections.at(-1)).toMatchObject({ reveal: true });

    fireEvent.click(screen.getByRole('button', { name: 'Mounts for app' }));
    const mounts = within(screen.getByText(/subPath app.conf · read-only/).closest('table')!);
    expect(mounts.getByText('/etc/config')).toBeInTheDocument();
    expect(mounts.getByText('/tmp')).toBeInTheDocument();
    fireEvent.click(mounts.getByRole('button', { name: 'configMap/app-config' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'ConfigMap', name: 'app-config' });

    fireEvent.click(screen.getByRole('button', { name: 'Command for app' }));
    expect(screen.getByText('/bin/app')).toBeInTheDocument();
    expect(screen.getByText('--serve')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Command for worker' })).not.toBeInTheDocument();

    // Another container's probes open independently.
    fireEvent.click(screen.getByRole('button', { name: 'Probes for worker' }));
    expect(screen.getByText('exec test -f /tmp/ready')).toBeInTheDocument();
  }, 15_000);

  it('opens logs and a shell scoped to a single container', () => {
    render(<PodDetail obj={richPod()} ctx="dev" />);

    // Only the running container can be exec'd into; the crashlooping one and
    // the finished init container still expose their logs.
    expect(screen.getByRole('button', { name: 'Shell into container app' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shell into container worker' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Logs for container worker' }));
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({
      kind: 'logs',
      title: 'logs: web-0/worker',
      namespace: 'team-a',
      pods: ['web-0'],
      container: 'worker',
    });

    // Finished init containers start collapsed — they're history, not the problem.
    expect(screen.getByText('all completed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Logs for container migrate' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Init containers/ }));
    expect(screen.queryByRole('button', { name: 'Shell into container migrate' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Logs for container migrate' }));
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({ kind: 'logs', container: 'migrate' });

    fireEvent.click(screen.getByRole('button', { name: 'Shell into container app' }));
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({ kind: 'terminal', pod: 'web-0', container: 'app' });
  });

  it('handles unavailable metrics, loading and empty environment data, and stop failures', () => {
    queries.metrics = new Map([['dev', { available: false, items: [] }]]);
    queries.env = undefined;
    queries.envLoading = true;
    queries.events = { items: [event('normal', 'Normal', '2026-07-22T10:00:00Z', { reason: 'Pulling' })] };
    queries.stopFails = true;
    const view = render(<PodDetail obj={richPod()} ctx="dev" />);

    expect(screen.getAllByText('no usage data').length).toBeGreaterThan(0);
    // While the env is loading the toggle exists and shows a spinner once opened.
    fireEvent.click(screen.getByRole('button', { name: 'Environment for app' }));
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    // The diagnosis explains the pod, so the latest normal event is not needed as a stand-in.
    expect(screen.queryByText('Pulling')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(effects.toast).toHaveBeenCalledWith('error', 'stop denied');

    view.unmount();
    queries.envLoading = false;
    queries.env = { containers: [] };
    render(<PodDetail obj={richPod()} ctx="dev" />);
    expect(screen.queryByRole('button', { name: 'Environment for app' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Shell into container main' })).not.toBeInTheDocument();
    expect(screen.getByText('8080/TCP')).not.toHaveAttribute('role', 'button');
    const containers = screen.getByText('Containers').closest('div')!;
    expect(within(containers).queryByText('Ready')).not.toBeInTheDocument();
  });

  it('explains a crash loop in words with the last output of the crashed run', () => {
    lastOutput.calls = [];
    lastOutput.lines = ['I crash in 5s'];
    const pod: KubeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'crashloop', namespace: 'chaos', uid: 'crash-uid', labels: {}, annotations: {} },
      spec: { restartPolicy: 'Always', containers: [{ name: 'crash', image: 'busybox', command: ['sh', '-c', 'echo "I crash in 5s"; sleep 5; exit 1'] }] },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'crash',
            ready: false,
            restartCount: 70,
            state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container=crash pod=crashloop_chaos(crash-uid)' } },
            lastState: { terminated: { reason: 'Error', exitCode: 1, startedAt: '2026-07-22T10:00:00Z', finishedAt: '2026-07-22T10:00:05Z' } },
          },
        ],
      },
    } as KubeObject;
    render(<PodDetail obj={pod} ctx="dev" />);

    const banner = screen.getByRole('alert', { name: 'Why this pod isn’t ready' });
    expect(within(banner).getByText('Container crash exits with code 1 about 5 s after starting')).toBeInTheDocument();
    expect(within(banner).getByText(/It has restarted 70 times\. Kubernetes now waits up to 5 minutes between attempts/)).toBeInTheDocument();
    expect(within(banner).getByText('I crash in 5s')).toBeInTheDocument();
    expect(lastOutput.calls.at(-1)).toMatchObject({ ctx: 'dev', namespace: 'chaos', pod: 'crashloop', container: 'crash', previous: true });
    expect(within(banner).getByText(`sh -c 'echo "I crash in 5s"; sleep 5; exit 1'`)).toBeInTheDocument();
    // The kubelet's own wording is folded away, and not repeated on the container panel.
    expect(screen.queryByText(/back-off 5m0s restarting/)).not.toBeInTheDocument();
    expect(tile('Restarts')).toHaveTextContent('70');
    expect(tile('Ready')).toHaveTextContent('0/1');

    fireEvent.click(within(banner).getByRole('button', { name: 'Previous logs' }));
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({ kind: 'logs', pods: ['crashloop'], container: 'crash', previous: true, follow: false });
    fireEvent.click(within(banner).getByRole('button', { name: 'Events' }));
    expect(useDetailStore.getState().tabRequest).toMatchObject({ selKey: 'dev||v1|pods|chaos|crashloop', tab: 'events' });
    fireEvent.click(within(banner).getByRole('button', { name: 'Kubelet message' }));
    expect(within(banner).getByText(/back-off 5m0s restarting failed container=crash/)).toBeInTheDocument();
  });
});
