import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterSignals, KubeObject } from '@kubus/shared';
import { StatefulSetDetail } from '../../../client/src/components/detail/StatefulSetDetail';
import { DaemonSetDetail } from '../../../client/src/components/detail/DaemonSetDetail';
import { useDetailStore } from '../../../client/src/state/detail';
import { useDockStore } from '../../../client/src/state/dock';

const queries = vi.hoisted(() => ({
  lists: {} as Record<string, KubeObject[]>,
  service: undefined as KubeObject | undefined,
  serviceError: undefined as unknown,
  nodes: [] as KubeObject[],
  signals: { windowMs: 3_600_000, objects: {} } as ClusterSignals,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  DETAIL_LIST_LIVE_MS: 5000,
  useResourceList: (selection: { plural?: string } | undefined) => ({ data: selection ? { items: queries.lists[selection.plural ?? ''] ?? [] } : undefined, isLoading: false }),
  useResource: (selection: unknown) => ({ data: selection ? queries.service : undefined, error: selection ? queries.serviceError : undefined }),
  isResourceGone: (error: unknown) => (error as { status?: number } | undefined)?.status === 404,
  useResourceMetrics: () => ({ data: undefined }),
  useClusterSignals: (contexts: string[]) => ({ data: contexts.length ? new Map([[contexts[0], queries.signals]]) : undefined }),
  useUsedBy: () => ({ data: { items: [], unavailable: [], truncated: 0 }, isLoading: false, isError: false }),
  useWatchedList: (contexts: string[]) => ({ rows: queries.nodes.map((obj) => ({ ctx: contexts[0], obj })), status: {} }),
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../../client/src/components/PortForwardDialog.js', () => ({ PortForwardDialog: ({ kind }: { kind: string }) => <div>Forward dialog {kind}</div> }));
vi.mock('../../../client/src/components/RowActions.js', () => ({
  SetImageDialog: ({ target, initialContainer }: { target: { kind: string; plural: string }; initialContainer?: string }) => (
    <div>
      Set image dialog {target.kind} {target.plural} {initialContainer}
    </div>
  ),
}));

const tile = (label: string) => {
  const term = screen.getAllByRole('term').find((el) => el.textContent === label);
  if (!term) throw new Error(`no summary tile labelled ${label}`);
  return term.nextElementSibling;
};

function statefulSet(): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: 'worker', namespace: 'jobs', uid: 'sts-uid', labels: {}, annotations: {} },
    spec: {
      replicas: 3,
      serviceName: 'worker',
      podManagementPolicy: 'Parallel',
      selector: { matchLabels: { app: 'worker' } },
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 2 } },
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Delete', whenScaled: 'Retain' },
      template: {
        spec: {
          containers: [
            {
              name: 'worker',
              image: 'busybox:1.36',
              ports: [{ name: 'http', containerPort: 8080 }],
              readinessProbe: { httpGet: { path: '/', port: 'http' } },
              volumeMounts: [{ name: 'data', mountPath: '/data' }],
            },
          ],
        },
      },
      volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: { resources: { requests: { storage: '64Mi' } } } }],
    },
    status: { replicas: 3, readyReplicas: 2, updatedReplicas: 1, availableReplicas: 2, currentReplicas: 2, currentRevision: 'worker-old', updateRevision: 'worker-new' },
  } as KubeObject;
}

function pod(name: string, owner: string, opts: { ready?: boolean; hash?: string; nodeName?: string; pending?: string; pinned?: string } = {}): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'jobs', uid: `uid-${name}`, labels: opts.hash ? { 'controller-revision-hash': opts.hash } : {}, ownerReferences: [{ kind: 'StatefulSet', name: 'x', uid: owner, controller: true }] },
    spec: {
      containers: [{ name: 'worker' }],
      ...(opts.nodeName && { nodeName: opts.nodeName }),
      ...(opts.pinned && { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [opts.pinned] }] }] } } } }),
    },
    status: opts.pending
      ? { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: opts.pending }] }
      : { phase: 'Running', containerStatuses: [{ name: 'worker', ready: opts.ready ?? true, state: { running: {} } }] },
  } as unknown as KubeObject;
}

function pvc(name: string, phase: string): KubeObject {
  return { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: 'jobs', uid: `pvc-${name}` }, spec: { storageClassName: 'standard' }, status: { phase, capacity: { storage: '64Mi' } } } as KubeObject;
}

function revision(name: string, number: number, owner: string, image: string): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'ControllerRevision',
    metadata: { name, namespace: 'jobs', uid: `cr-${name}`, ownerReferences: [{ kind: 'StatefulSet', name: 'worker', uid: owner, controller: true }] },
    revision: number,
    data: { spec: { template: { spec: { containers: [{ name: 'worker', image }] } } } },
  } as unknown as KubeObject;
}

beforeEach(() => {
  queries.lists = {};
  queries.service = undefined;
  queries.serviceError = undefined;
  queries.nodes = [];
  queries.signals = { windowMs: 3_600_000, objects: {} };
  useDockStore.setState({ tabs: [], activeId: undefined, open: false, maximized: false });
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, drafts: {}, pendingDiscard: undefined });
});

describe('StatefulSetDetail', () => {
  beforeEach(() => {
    queries.lists = {
      pods: [pod('worker-10', 'sts-uid', { hash: 'worker-new' }), pod('worker-2', 'sts-uid', { hash: 'worker-old' }), pod('worker-0', 'sts-uid', { hash: 'worker-old', ready: false }), pod('other-0', 'someone-else')],
      persistentvolumeclaims: [pvc('data-worker-0', 'Bound'), pvc('data-worker-1', 'Pending'), pvc('data-worker-7', 'Bound')],
      controllerrevisions: [revision('worker-old', 1, 'sts-uid', 'busybox:1.36'), revision('worker-new', 2, 'sts-uid', 'busybox:latest')],
    };
    queries.service = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'worker', uid: 'svc' }, spec: { clusterIP: 'None' } } as KubeObject;
  });

  it('shows rollout counters, the partition and bound claims', () => {
    render(<StatefulSetDetail obj={statefulSet()} ctx="dev" />);
    expect(tile('Ready')).toHaveTextContent('2/3');
    expect(tile('Updated')).toHaveTextContent('1/3');
    expect(tile('Partition')).toHaveTextContent('2');
    expect(tile('Claims bound')).toHaveTextContent('1/3');
    expect(screen.getByText('2 of 3 ready')).toBeInTheDocument();
    expect(screen.getByText('2 on old template · partition 2')).toBeInTheDocument();
  });

  it('lists its own pods in ordinal order', () => {
    render(<StatefulSetDetail obj={statefulSet()} ctx="dev" />);
    const pods = screen.getAllByText(/^worker-\d+$/).map((el) => el.textContent);
    expect(pods.slice(0, 3)).toEqual(['worker-0', 'worker-2', 'worker-10']);
    expect(screen.queryByText('other-0')).not.toBeInTheDocument();
  });

  it('gives each ordinal’s claim a row and opens it', () => {
    render(<StatefulSetDetail obj={statefulSet()} ctx="dev" />);
    const section = screen.getByRole('button', { name: /Volume claims/ }).closest('div')!.parentElement!;
    const claims = within(section);
    expect(claims.getByText('data-worker-2')).toBeInTheDocument();
    expect(claims.getByText('not created')).toBeInTheDocument();
    expect(claims.getByText('retained')).toBeInTheDocument();
    fireEvent.click(claims.getByRole('button', { name: 'data-worker-1' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'PersistentVolumeClaim', name: 'data-worker-1', namespace: 'jobs' });
  });

  it('links the headless Service and spells out per-pod DNS', () => {
    render(<StatefulSetDetail obj={statefulSet()} ctx="dev" />);
    expect(screen.getByText(/headless/)).toBeInTheDocument();
    expect(screen.getByText('worker-{0..2}.worker.jobs.svc.cluster.local')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Open Service worker'));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Service', name: 'worker' });
  });

  it('warns when the governing Service is missing or not headless', () => {
    queries.service = undefined;
    queries.serviceError = { status: 404 };
    const { unmount } = render(<StatefulSetDetail obj={statefulSet()} ctx="dev" />);
    expect(screen.getByText('not found')).toBeInTheDocument();
    expect(screen.queryByText(/svc\.cluster\.local/)).not.toBeInTheDocument();
    unmount();

    queries.serviceError = undefined;
    queries.service = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'worker', uid: 'svc' }, spec: { clusterIP: '10.0.0.9' } } as KubeObject;
    render(<StatefulSetDetail obj={statefulSet()} ctx="dev" />);
    expect(screen.getByText('not headless (cluster IP 10.0.0.9)')).toBeInTheDocument();
  });

  it('shows the revisions holding pods with their images', () => {
    render(<StatefulSetDetail obj={statefulSet()} ctx="dev" />);
    // Two revisions hold pods, so the section opens itself.
    expect(screen.getByText('busybox:latest')).toBeInTheDocument();
    expect(screen.getAllByText('busybox:1.36').length).toBeGreaterThan(0);
    expect(screen.getByText('current')).toBeInTheDocument();
  });

  it('offers set image and logs for its containers, and resolves named probe ports', () => {
    render(<StatefulSetDetail obj={statefulSet()} ctx="dev" />);
    fireEvent.click(screen.getByRole('button', { name: 'Change image of worker' }));
    expect(screen.getByText('Set image dialog StatefulSet statefulsets worker')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Logs for container worker' }));
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({ kind: 'logs', target: { kind: 'StatefulSet', name: 'worker' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probes for worker' }));
    expect(screen.getByText('HTTP / :http (8080)')).toBeInTheDocument();
  });

  it('explains a refused pod with the controller’s event and links the quota', () => {
    const blocked = statefulSet();
    blocked.status = { replicas: 0, readyReplicas: 0 };
    queries.lists.pods = [];
    queries.signals = {
      windowMs: 3_600_000,
      objects: {
        'StatefulSet|jobs|worker': {
          warnings: [{ reason: 'FailedCreate', message: 'create Pod worker-0 in StatefulSet worker failed error: pods "worker-0" is forbidden: exceeded quota: gpu-quota', count: 1, total: 14 }],
        },
      },
    };
    render(<StatefulSetDetail obj={blocked} ctx="dev" />);
    const banner = screen.getByRole('alert');
    expect(within(banner).getByText('Why this StatefulSet isn’t ready')).toBeInTheDocument();
    expect(within(banner).getByText('FailedCreate ×14')).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole('button', { name: 'Open ResourceQuota gpu-quota' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'ResourceQuota', name: 'gpu-quota', namespace: 'jobs' });
  });
});

function daemonSet(): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: 'agent', namespace: 'jobs', uid: 'ds-uid', labels: {}, annotations: {} },
    spec: {
      selector: { matchLabels: { app: 'agent' } },
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } },
      template: { spec: { nodeSelector: { pool: 'general' }, tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'batch', effect: 'NoSchedule' }], containers: [{ name: 'agent', image: 'agent:1' }] } },
    },
    status: { desiredNumberScheduled: 2, currentNumberScheduled: 2, numberReady: 1, updatedNumberScheduled: 2, numberAvailable: 1, numberMisscheduled: 0 },
  } as KubeObject;
}

function node(name: string, labels: Record<string, string>, taints: Array<{ key: string; value?: string; effect: string }> = []): KubeObject {
  return { apiVersion: 'v1', kind: 'Node', metadata: { name, uid: `node-${name}`, labels }, spec: { taints } } as KubeObject;
}

describe('DaemonSetDetail', () => {
  const cpu = '0/3 nodes are available: 1 Insufficient cpu. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.';
  beforeEach(() => {
    queries.lists = {
      pods: [pod('agent-aaa', 'ds-uid', { nodeName: 'node-a' }), pod('agent-bbb', 'ds-uid', { pending: cpu, pinned: 'node-b' })],
    };
    queries.nodes = [node('node-a', { pool: 'general' }), node('node-b', { pool: 'general' }), node('node-c', { pool: 'gpu' }, [{ key: 'nvidia.com/gpu', effect: 'NoSchedule' }])];
  });

  it('shows desired, current, ready, up-to-date and misscheduled counts', () => {
    render(<DaemonSetDetail obj={daemonSet()} ctx="dev" />);
    expect(tile('Desired')).toHaveTextContent('2');
    expect(tile('Current')).toHaveTextContent('2');
    expect(tile('Ready')).toHaveTextContent('1/2');
    expect(tile('Up-to-date')).toHaveTextContent('2');
    expect(tile('Misscheduled')).toHaveTextContent('0');
  });

  it('says why the Pending pod can’t run, on its node, with a link to the node', () => {
    render(<DaemonSetDetail obj={daemonSet()} ctx="dev" />);
    const banner = screen.getByRole('alert');
    expect(within(banner).getByText('1 pod Pending: 0/3 nodes available, Insufficient cpu')).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole('button', { name: 'Open node node-b' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Node', name: 'node-b' });
  });

  it('lists the nodes without a ready pod and why', () => {
    render(<DaemonSetDetail obj={daemonSet()} ctx="dev" />);
    const section = screen.getByRole('button', { name: /^Nodes/ }).closest('div')!.parentElement!;
    const nodes = within(section);
    expect(nodes.getByText('1 of 3 running a ready pod · 1 need attention · 1 excluded')).toBeInTheDocument();
    // node-b: the scheduler's short answer; node-c: selector and taint.
    expect(nodes.getAllByText('Insufficient cpu').length).toBeGreaterThan(0);
    expect(nodes.getByText('nodeSelector pool=general not matched')).toBeInTheDocument();
    expect(nodes.getByText('taint nvidia.com/gpu:NoSchedule not tolerated')).toBeInTheDocument();
    expect(nodes.queryByText('node-a')).not.toBeInTheDocument();
    fireEvent.click(nodes.getByRole('button', { name: 'node-c' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Node', name: 'node-c' });
  });

  it('shows each pod’s node and the template’s placement rules', () => {
    render(<DaemonSetDetail obj={daemonSet()} ctx="dev" />);
    // Pods table: the running pod's node and the Pending pod's target node.
    expect(screen.getAllByRole('button', { name: 'node-a' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'node-b' }).length).toBeGreaterThan(0);
    expect(screen.getByText('pool=general')).toBeInTheDocument();
    expect(screen.getByText('dedicated=batch:NoSchedule')).toBeInTheDocument();
  });
});
