import { fireEvent, render, screen } from '@testing-library/react';
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
      template: { spec: { containers: [{ name: 'app' }, { name: 'broken' }] } },
    },
    status: { readyReplicas: 1, updatedReplicas: 2, availableReplicas: 1, unavailableReplicas: 1 },
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
        state: running.includes(name) ? { running: {} } : { waiting: { reason: 'CrashLoopBackOff' } },
      })),
    },
  } as unknown as KubeObject;
}

beforeEach(() => {
  queries.replicaSets = [
    { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { name: 'web-1', namespace: 'team-a', uid: 'rs-uid', ownerReferences: [{ kind: 'Deployment', uid: 'deploy-uid', controller: true, name: 'web' }] } } as KubeObject,
  ];
  // The first pod never got `app` running, so a shell must land in the second.
  queries.pods = [pod('web-aaa', ['broken']), pod('web-bbb', ['app', 'broken'])];
  queries.metrics = undefined;
  effects.toast.mockClear();
  useDockStore.setState({ tabs: [], activeId: undefined, open: false, maximized: false });
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, pendingDiscard: undefined });
});

describe('DeploymentDetail', () => {
  it('summarizes rollout facts without chips', () => {
    render(<DeploymentDetail obj={deployment()} ctx="dev" />);

    expect(screen.getByText('2 updated · 1 available · 1 unavailable')).toBeInTheDocument();
    expect(screen.getByText(/RollingUpdate/)).toBeInTheDocument();
    expect(screen.getByText(/max unavailable 1 · max surge 25%/)).toBeInTheDocument();
    expect(screen.getByText('app=web')).toBeInTheDocument();
    // Ready fact for the Deployment, plus one per pod row.
    expect(screen.getAllByText('1/2').length).toBeGreaterThan(1);
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
});
