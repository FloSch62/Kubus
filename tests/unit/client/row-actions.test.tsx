import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  isLogTargetKind,
  RowActionMenu,
  RowActions,
  RowLogsButton,
  SetImageDialog,
  type RowActionTarget,
} from '../../../client/src/components/RowActions';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useDockStore } from '../../../client/src/state/dock';
import { useNavigationStore } from '../../../client/src/state/navigation';

const queryMocks = vi.hoisted(() => {
  const mutation = (value: unknown = {}) => ({
    isPending: false,
    mutate: vi.fn((_vars: unknown, options?: { onSuccess?: (result: unknown) => void; onError?: (error: unknown) => void }) => {
      options?.onSuccess?.(value);
    }),
    mutateAsync: vi.fn(async () => value),
  });
  return {
    resolveLogTargetPods: vi.fn(async () => ({
      pods: [
        { name: 'pod-a', namespace: 'team-a', containers: ['app', 'sidecar'] },
        { name: 'pod-b', namespace: 'team-a', containers: ['app'] },
        { name: 'pod-c', namespace: 'team-b', containers: ['app'] },
      ],
    })),
    deleteResource: mutation(),
    restart: mutation(),
    cordon: mutation(),
    rerun: mutation({ jobName: 'manual-job' }),
    pause: mutation(),
    suspend: mutation(),
    scale: mutation(),
    setImage: mutation(),
    debug: mutation({ containerName: 'debugger-1' }),
    drain: mutation({ drainId: 'drain-1' }),
    startPort: mutation({ localPort: 8080, remotePort: 80 }),
    create: mutation({ metadata: { name: 'manual-job' } }),
    dryRun: mutation({ ok: true, findings: [] }),
    hpas: [] as KubeObject[],
    services: [] as KubeObject[],
    preflight: { allowed: true } as { allowed: boolean; reason?: string },
    localPort: vi.fn(async () => ({ available: true })),
  };
});

const sideEffects = vi.hoisted(() => ({
  copy: vi.fn(async () => true),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  broadcasts: new Set<(message: Record<string, unknown>) => void>(),
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  resolveLogTargetPods: queryMocks.resolveLogTargetPods,
  useDeleteResource: () => queryMocks.deleteResource,
  useRolloutRestart: () => queryMocks.restart,
  useCordon: () => queryMocks.cordon,
  useRerunJob: () => queryMocks.rerun,
  useRolloutPause: () => queryMocks.pause,
  useSuspendCronJob: () => queryMocks.suspend,
  useScale: () => queryMocks.scale,
  useSetImage: () => queryMocks.setImage,
  useDebugPod: () => queryMocks.debug,
  useDrain: () => queryMocks.drain,
  useStartPortForward: () => queryMocks.startPort,
  usePortForwardPreflight: () => ({ data: queryMocks.preflight }),
  checkLocalPort: queryMocks.localPort,
  useCreateResource: () => queryMocks.create,
  useDryRunResource: () => queryMocks.dryRun,
  useResourceSchema: () => ({ data: undefined }),
  useResourceList: (selection: { plural?: string } | undefined) => ({
    data: selection?.plural === 'horizontalpodautoscalers'
      ? { items: queryMocks.hpas }
      : selection?.plural === 'services'
        ? { items: queryMocks.services }
        : undefined,
    isLoading: false,
  }),
}));

vi.mock('../../../client/src/api/ws/watch-client.js', () => ({
  watchClient: {
    onBroadcast: (handler: (message: Record<string, unknown>) => void) => {
      sideEffects.broadcasts.add(handler);
      return () => sideEffects.broadcasts.delete(handler);
    },
  },
}));
vi.mock('../../../client/src/clipboard.js', () => ({ copyToClipboard: sideEffects.copy }));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: sideEffects.showToast, showErrorToast: sideEffects.showErrorToast }));
vi.mock('../../../client/src/components/YamlEditor.js', () => ({
  YamlEditor: ({ onApply, onDryRun }: { onApply?: (text: string) => Promise<void>; onDryRun?: (text: string) => Promise<unknown> }) => (
    <div>
      <button onClick={() => void onDryRun?.('kind: Job')}>Dry run generated job</button>
      <button onClick={() => void onApply?.('kind: Job')}>Create generated job</button>
    </div>
  ),
}));

function obj(kind: string, name: string, spec: Record<string, unknown> = {}, extra: Partial<KubeObject> = {}): KubeObject {
  return {
    apiVersion: kind === 'Pod' || kind === 'Service' || kind === 'Node' ? 'v1' : kind === 'Job' || kind === 'CronJob' ? 'batch/v1' : 'apps/v1',
    kind,
    metadata: { name, namespace: kind === 'Node' ? undefined : 'team-a', uid: `uid-${name}`, ...extra.metadata },
    spec,
    status: {},
    ...extra,
  };
}

const gvr: Record<string, { group: string; version: string; plural: string }> = {
  Pod: { group: '', version: 'v1', plural: 'pods' },
  Service: { group: '', version: 'v1', plural: 'services' },
  Node: { group: '', version: 'v1', plural: 'nodes' },
  Deployment: { group: 'apps', version: 'v1', plural: 'deployments' },
  StatefulSet: { group: 'apps', version: 'v1', plural: 'statefulsets' },
  DaemonSet: { group: 'apps', version: 'v1', plural: 'daemonsets' },
  ReplicaSet: { group: 'apps', version: 'v1', plural: 'replicasets' },
  Job: { group: 'batch', version: 'v1', plural: 'jobs' },
  CronJob: { group: 'batch', version: 'v1', plural: 'cronjobs' },
};

function target(kind: string, spec: Record<string, unknown> = {}, extra: Partial<KubeObject> = {}): RowActionTarget {
  const resource = gvr[kind] ?? { group: 'example.io', version: 'v1', plural: 'widgets' };
  return { ctx: 'dev', ...resource, kind, obj: obj(kind, `${kind.toLowerCase()}-a`, spec, extra) };
}

function renderMenu(value: RowActionTarget) {
  const onClose = vi.fn();
  const view = render(
    <MemoryRouter>
      <RowActionMenu target={value} anchorPosition={{ top: 10, left: 10 }} open onClose={onClose} />
    </MemoryRouter>,
  );
  return { ...view, onClose };
}

function clickMenuAction(value: RowActionTarget, label: string | RegExp) {
  const view = renderMenu(value);
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
  return view;
}

beforeEach(() => {
  vi.stubGlobal('open', vi.fn());
  for (const value of Object.values(queryMocks)) {
    if (value && typeof value === 'object' && 'mutate' in value) {
      (value.mutate as ReturnType<typeof vi.fn>).mockClear();
      (value.mutateAsync as ReturnType<typeof vi.fn>).mockClear();
    }
  }
  queryMocks.resolveLogTargetPods.mockClear();
  queryMocks.hpas = [];
  queryMocks.services = [];
  queryMocks.preflight = { allowed: true };
  queryMocks.localPort.mockClear();
  sideEffects.copy.mockClear();
  sideEffects.showToast.mockClear();
  sideEffects.showErrorToast.mockClear();
  sideEffects.broadcasts.clear();
  useClustersStore.setState({ contextSettings: { dev: { protected: true } }, selected: ['dev'] });
  useNavigationStore.setState({ favorites: [], savedViews: [] });
  useDockStore.setState({ tabs: [], activeId: undefined, open: false, maximized: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('row action helpers', () => {
  it('recognizes log targets and opens grouped log tabs from the inline button', async () => {
    expect(isLogTargetKind('Pod')).toBe(true);
    expect(isLogTargetKind('Service')).toBe(true);
    expect(isLogTargetKind('Widget')).toBe(false);

    const pod = target('Pod', { containers: [{ name: 'app' }] });
    const view = render(
      <MemoryRouter>
        <RowLogsButton target={pod} />
        <RowLogsButton target={target('Widget')} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByLabelText('Logs for pod-a'));
    await waitFor(() => expect(useDockStore.getState().tabs).toHaveLength(2));
    expect(useDockStore.getState().tabs[0]).toMatchObject({ kind: 'logs', namespace: 'team-a', pods: ['pod-a', 'pod-b'] });
    expect(view.container.querySelectorAll('button')).toHaveLength(1);
  });

  it('mounts the full menu lazily from the compact row button', () => {
    const pod = target('Pod', { containers: [{ name: 'app' }] });
    render(
      <MemoryRouter>
        <RowActions target={pod} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Actions for pod-a'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('pod actions', () => {
  const pod = target('Pod', {
    containers: [{ name: 'app', ports: [{ containerPort: 8080, name: 'http' }] }],
    initContainers: [{ name: 'setup' }],
  });

  it('opens logs, a shell, files, debug, and port-forward flows', async () => {
    let view = clickMenuAction(pod, 'Logs');
    await waitFor(() => expect(queryMocks.resolveLogTargetPods).toHaveBeenCalled());
    view.unmount();

    view = clickMenuAction(pod, 'Shell');
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({ kind: 'terminal', pod: 'pod-a', container: 'app' });
    view.unmount();

    view = clickMenuAction(pod, 'Files…');
    expect(screen.getByText('Files — pod-a')).toBeInTheDocument();
    view.unmount();

    view = clickMenuAction(pod, 'Debug container…');
    expect(screen.getByText('Debug container — pod-a')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'alpine:3.21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(queryMocks.debug.mutate).toHaveBeenCalled();
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({ kind: 'terminal', container: 'debugger-1' });
    view.unmount();

    queryMocks.services = [
      obj('Service', 'web', { selector: { app: 'web' }, ports: [{ name: 'http', port: 80, targetPort: 8080 }] }),
    ];
    pod.obj.metadata.labels = { app: 'web' };
    view = clickMenuAction(pod, 'Port forward…');
    expect(screen.getByText('Port forward — pod/pod-a')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Local port'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Open in browser when started'));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(queryMocks.startPort.mutate).toHaveBeenCalled();
    view.unmount();
  });

  it('debug image presets fill the field and pair the power tier with netadmin', () => {
    const view = clickMenuAction(pod, 'Debug container…');
    fireEvent.click(screen.getByText('DebugBox power'));
    expect(screen.getByLabelText('Image')).toHaveValue('ghcr.io/ibtisam-iq/debugbox:power-1.2.0');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(queryMocks.debug.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ image: 'ghcr.io/ibtisam-iq/debugbox:power-1.2.0', profile: 'netadmin' }) }),
      expect.anything(),
    );
    view.unmount();
  });

  it('favorites, copies, and confirms deletion of protected resources', async () => {
    let view = clickMenuAction(pod, 'Add to favorites');
    expect(useNavigationStore.getState().favorites).toHaveLength(1);
    view.unmount();

    view = clickMenuAction(pod, 'Remove favorite');
    expect(useNavigationStore.getState().favorites).toHaveLength(0);
    view.unmount();

    view = clickMenuAction(pod, 'Copy link');
    await waitFor(() => expect(sideEffects.copy).toHaveBeenCalled());
    view.unmount();

    view = clickMenuAction(pod, 'Delete…');
    const confirm = screen.getByPlaceholderText('pod-a');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    fireEvent.change(confirm, { target: { value: 'pod-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(queryMocks.deleteResource.mutate).toHaveBeenCalled();
    view.unmount();
  });
});

describe('workload actions', () => {
  const deployment = target('Deployment', {
    replicas: 2,
    template: {
      metadata: { labels: { app: 'web' } },
      spec: {
        containers: [{ name: 'app', image: 'registry.example.test/team/app:1.0', ports: [{ containerPort: 8080 }] }],
        initContainers: [{ name: 'setup', image: 'busybox@sha256:abc' }],
      },
    },
  });

  it('resolves a KEDA-owned HPA and overrides its replicas', () => {
    queryMocks.hpas = [
      obj(
        'HorizontalPodAutoscaler',
        'web-hpa',
        { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'deployment-a' }, minReplicas: 1, maxReplicas: 10 },
        {
          metadata: {
            name: 'web-hpa',
            namespace: 'team-a',
            uid: 'hpa',
            ownerReferences: [{ apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject', name: 'web-scaler', uid: 'scaled', controller: true }],
          },
        },
      ),
    ];
    const view = clickMenuAction(deployment, 'Override replicas…');
    expect(screen.getByText(/managed by ScaledObject/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Override the autoscaler/));
    fireEvent.change(screen.getByLabelText('Replicas'), { target: { value: '0' } });
    fireEvent.change(screen.getByPlaceholderText('deployment-a'), { target: { value: 'deployment-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Override' }));
    expect(queryMocks.scale.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ replicas: 0 }) }),
      expect.anything(),
    );
    view.unmount();
  });

  it('restarts, pauses, and changes workload images', () => {
    let view = clickMenuAction(deployment, 'Rollout restart');
    expect(queryMocks.restart.mutate).toHaveBeenCalled();
    view.unmount();

    view = clickMenuAction(deployment, 'Pause rollout');
    expect(queryMocks.pause.mutate).toHaveBeenCalled();
    view.unmount();

    view = clickMenuAction(deployment, 'Set image…');
    expect(screen.getByText('Set image — deployment-a')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: '2.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(queryMocks.setImage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ image: 'registry.example.test/team/app:2.0' }) }),
      expect.anything(),
    );
    view.unmount();
  });

  it('supports full-image mode and containers without an existing image', () => {
    const noImage = target('Deployment', { template: { spec: { containers: [{ name: 'app' }] } } });
    const view = render(
      <MemoryRouter>
        <SetImageDialog target={noImage} onClose={vi.fn()} onDone={vi.fn()} onError={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'nginx:latest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(queryMocks.setImage.mutate).toHaveBeenCalled();
    view.unmount();
  });
});

describe('controller and node actions', () => {
  it('reruns jobs and triggers or suspends CronJobs', async () => {
    let view = clickMenuAction(target('Job'), 'Re-run');
    expect(queryMocks.rerun.mutate).toHaveBeenCalled();
    view.unmount();

    const cron = target('CronJob', { suspend: false, jobTemplate: { spec: { template: { spec: { containers: [{ name: 'job', image: 'busybox' }] } } } } });
    view = clickMenuAction(cron, 'Suspend');
    expect(queryMocks.suspend.mutate).toHaveBeenCalled();
    view.unmount();

    view = clickMenuAction(cron, 'Trigger now…');
    expect(screen.getByText('Trigger cronjob-a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run generated job' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create generated job' }));
    await waitFor(() => expect(queryMocks.create.mutateAsync).toHaveBeenCalled());
    view.unmount();
  });

  it('restarts ReplicaSet pods with typed confirmation', () => {
    const rs = target('ReplicaSet', {}, {
      metadata: {
        name: 'replicaset-a',
        namespace: 'team-a',
        uid: 'rs',
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'deploy', controller: true }],
      },
    });
    const view = clickMenuAction(rs, 'Restart pods…');
    expect(screen.getByText(/managed by a Deployment/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('replicaset-a'), { target: { value: 'replicaset-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(queryMocks.restart.mutate).toHaveBeenCalled();
    view.unmount();
  });

  it('cordons, opens a shell on, and drains a protected node', async () => {
    const node = target('Node', { unschedulable: false });
    let view = clickMenuAction(node, 'Cordon');
    expect(queryMocks.cordon.mutate).toHaveBeenCalled();
    view.unmount();

    view = clickMenuAction(node, 'Node shell…');
    fireEvent.change(screen.getByPlaceholderText('node-a'), { target: { value: 'node-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open shell' }));
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({ kind: 'node-shell', node: 'node-a' });
    view.unmount();

    view = clickMenuAction(node, 'Drain…');
    fireEvent.change(screen.getByPlaceholderText('node-a'), { target: { value: 'node-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Drain' }));
    expect(queryMocks.drain.mutate).toHaveBeenCalled();
    for (const handler of sideEffects.broadcasts) {
      handler({ op: 'drain-progress', drainId: 'drain-1', evicted: 2, total: 2, done: true });
    }
    await waitFor(() => expect(screen.getByText(/Done — evicted 2\/2 pods/)).toBeInTheDocument());
    view.unmount();
  });
});
