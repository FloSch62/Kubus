import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { DeploymentDetail } from '../../../client/src/components/detail/DeploymentDetail';
import { useDockStore } from '../../../client/src/state/dock';
import { useDetailStore } from '../../../client/src/state/detail';

const queries = vi.hoisted(() => ({
  replicaSets: [] as KubeObject[],
  pods: [] as KubeObject[],
  metrics: undefined as Map<string, unknown> | undefined,
}));

const effects = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../../../client/src/api/queries.js', () => ({
  DETAIL_LIST_LIVE_MS: 5000,
  useResourceList: (selection: { plural?: string } | undefined) => ({
    data: !selection ? undefined : { items: selection.plural === 'replicasets' ? queries.replicaSets : queries.pods },
    isLoading: false,
  }),
  useResourceMetrics: () => ({ data: queries.metrics }),
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
vi.mock('../../../client/src/components/PortForwardDialog.js', () => ({ PortForwardDialog: () => <div>Forward dialog</div> }));
vi.mock('../../../client/src/components/RowActions.js', () => ({ SetImageDialog: () => <div>Set image dialog</div> }));

function deployment(): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: 'team-a', uid: 'deploy-uid', labels: {}, annotations: {} },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'web' } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: '25%' } },
      progressDeadlineSeconds: 600,
      template: {
        spec: {
          containers: [
            {
              name: 'app',
              image: 'example/app:v2',
              env: [
                { name: 'MODE', value: 'prod' },
                { name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'app-secret', key: 'token' } } },
              ],
              envFrom: [{ configMapRef: { name: 'app-config' } }],
              volumeMounts: [{ name: 'data', mountPath: '/data' }],
              readinessProbe: { httpGet: { path: '/healthz', port: 8080 } },
            },
            { name: 'broken' },
          ],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-pvc' } }],
        },
      },
    },
    status: {
      replicas: 2,
      readyReplicas: 1,
      updatedReplicas: 2,
      availableReplicas: 1,
      unavailableReplicas: 1,
      conditions: [
        { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.' },
        { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated' },
      ],
    },
  } as KubeObject;
}

function pod(name: string, running: string[]): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'team-a', uid: `uid-${name}`, ownerReferences: [{ kind: 'ReplicaSet', uid: 'rs-uid', controller: true, name: 'web-1' }] },
    spec: { containers: [{ name: 'app' }, { name: 'broken' }] },
    status: {
      phase: 'Running',
      containerStatuses: ['app', 'broken'].map((name) => ({
        name,
        ready: running.includes(name),
        state: running.includes(name) ? { running: {} } : { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m restarting failed container' } },
      })),
    },
  } as unknown as KubeObject;
}

function replicaSet(name: string, uid: string, revision: string, replicas: number, ready: number): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name,
      namespace: 'team-a',
      uid,
      annotations: { 'deployment.kubernetes.io/revision': revision },
      ownerReferences: [{ kind: 'Deployment', uid: 'deploy-uid', controller: true, name: 'web' }],
    },
    spec: { replicas },
    status: { replicas, readyReplicas: ready },
  } as unknown as KubeObject;
}

/** Value tile of the summary strip, addressed by its label (a <dt> has no accessible name of its own). */
const tile = (label: string) => {
  const term = screen.getAllByRole('term').find((el) => el.textContent === label);
  if (!term) throw new Error(`no summary tile labelled ${label}`);
  return term.nextElementSibling;
};

beforeEach(() => {
  queries.replicaSets = [replicaSet('web-1', 'rs-uid', '3', 2, 1), replicaSet('web-0', 'rs-old', '2', 0, 0)];
  // The first pod never got `app` running, so a shell must land in the second.
  queries.pods = [pod('web-aaa', ['broken']), pod('web-bbb', ['app', 'broken'])];
  queries.metrics = undefined;
  effects.toast.mockClear();
  useDockStore.setState({ tabs: [], activeId: undefined, open: false, maximized: false });
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, drafts: {}, pendingDiscard: undefined });
});

describe('DeploymentDetail', () => {
  it('summarizes the rollout: counters, progress, and why it is not ready', () => {
    render(<DeploymentDetail obj={deployment()} ctx="dev" />);

    expect(tile('Ready')).toHaveTextContent('1/2');
    expect(tile('Updated')).toHaveTextContent('2');
    expect(tile('Available')).toHaveTextContent('1');
    expect(tile('Unavailable')).toHaveTextContent('1');
    expect(screen.getByText('1 of 2 ready')).toBeInTheDocument();
    // Ready tile plus one per pod row.
    expect(screen.getAllByText('1/2').length).toBeGreaterThan(1);

    // The failing condition in full, plus the pods' own reason.
    const banner = screen.getByRole('alert');
    expect(within(banner).getByText('Why this Deployment isn’t ready')).toBeInTheDocument();
    expect(within(banner).getByText(/Available: MinimumReplicasUnavailable/)).toBeInTheDocument();
    expect(within(banner).getByText('Deployment does not have minimum availability.')).toBeInTheDocument();
    expect(within(banner).getByText('1 pod CrashLoopBackOff')).toBeInTheDocument();
    expect(within(banner).getByText('back-off 5m restarting failed container')).toBeInTheDocument();

    expect(screen.getByText('1 CrashLoopBackOff · 1 Running')).toBeInTheDocument();
    expect(screen.getByText('app=web')).toBeInTheDocument();
    expect(screen.getByText(/RollingUpdate/)).toBeInTheDocument();
    expect(screen.getByText(/max unavailable 1 · max surge 25%/)).toBeInTheDocument();
    expect(screen.getByText('600s')).toBeInTheDocument();
  });

  it('shows the template’s declared environment, mounts and probes without a live pod', () => {
    render(<DeploymentDetail obj={deployment()} ctx="dev" />);

    fireEvent.click(screen.getByRole('button', { name: 'Environment for app' }));
    expect(screen.getByText('MODE')).toBeInTheDocument();
    expect(screen.getByText('prod')).toBeInTheDocument();
    expect(screen.getByText('TOKEN')).toBeInTheDocument();
    expect(screen.getByText('secret/app-secret → token')).toBeInTheDocument();
    expect(screen.getByText('configmap/app-config')).toBeInTheDocument();
    // Declared references have no resolved value and no reveal toggle.
    expect(screen.queryByRole('switch', { name: 'Reveal secret values' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mounts for app' }));
    expect(screen.getByText('/data')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'persistentVolumeClaim/data-pvc' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'PersistentVolumeClaim', name: 'data-pvc', namespace: 'team-a' });

    fireEvent.click(screen.getByRole('button', { name: 'Probes for app' }));
    expect(screen.getByText('HTTP /healthz :8080')).toBeInTheDocument();
    // Templates have no runtime, so no probe outcome is claimed.
    expect(screen.getByText('HTTP /healthz :8080').closest('tr')).not.toHaveTextContent('Ready');
  });

  it('lists the replica sets that still hold pods and opens them', () => {
    render(<DeploymentDetail obj={deployment()} ctx="dev" />);

    // web-0 is scaled to zero and belongs to the History tab.
    expect(screen.getByText('1 older scaled to zero — see History')).toBeInTheDocument();
    expect(screen.queryByText('web-0')).not.toBeInTheDocument();
    // A single live ReplicaSet is the normal case, so the section starts collapsed.
    fireEvent.click(screen.getByRole('button', { name: /Replica sets/ }));
    expect(screen.getByText('current')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'web-1' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'ReplicaSet', name: 'web-1' });
  });

  it('streams one container across every pod and shells into a pod running it', () => {
    render(<DeploymentDetail obj={deployment()} ctx="dev" />);

    fireEvent.click(screen.getByRole('button', { name: 'Logs for container app' }));
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({
      kind: 'logs',
      title: 'logs: web/app',
      container: 'app',
      pods: ['web-aaa', 'web-bbb'],
      target: { kind: 'Deployment', name: 'web' },
    });

    // web-aaa's `app` is crashlooping, so the shell has to pick web-bbb.
    fireEvent.click(screen.getByRole('button', { name: 'Shell into container app' }));
    expect(useDockStore.getState().tabs.at(-1)).toMatchObject({
      kind: 'terminal',
      title: 'sh: web-bbb/app',
      pod: 'web-bbb',
      container: 'app',
    });
  });

  it('offers no shell for a container no pod is running', () => {
    queries.pods = [pod('web-aaa', ['app'])];
    render(<DeploymentDetail obj={deployment()} ctx="dev" />);

    expect(screen.getByRole('button', { name: 'Shell into container app' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shell into container broken' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logs for container broken' })).toBeInTheDocument();
  });

  it('reports when a container has no pods to stream at all', () => {
    queries.pods = [];
    render(<DeploymentDetail obj={deployment()} ctx="dev" />);

    fireEvent.click(screen.getByRole('button', { name: 'Logs for container app' }));
    expect(effects.toast).toHaveBeenCalledWith('error', expect.stringContaining('No running pods'));
    expect(useDockStore.getState().tabs).toHaveLength(0);
  });

  it('stays quiet when every replica is ready', () => {
    const healthy = deployment();
    healthy.status = { replicas: 2, readyReplicas: 2, updatedReplicas: 2, availableReplicas: 2, conditions: [{ type: 'Available', status: 'True' }] };
    queries.pods = [pod('web-aaa', ['app', 'broken']), pod('web-bbb', ['app', 'broken'])];
    render(<DeploymentDetail obj={healthy} ctx="dev" />);

    expect(screen.getByText('2 of 2 ready')).toBeInTheDocument();
    expect(screen.queryByText('Why this Deployment isn’t ready')).not.toBeInTheDocument();
    expect(screen.getByText('2 Running')).toBeInTheDocument();
  });
});
