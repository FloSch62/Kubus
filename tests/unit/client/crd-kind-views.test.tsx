import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject, ResourceKindInfo } from '@kubus/shared';
import { CustomResourceDetail } from '../../../client/src/components/detail/CustomResourceDetail';
import { RouteDetail } from '../../../client/src/components/detail/kinds/RouteDetail';
import { RolloutActions } from '../../../client/src/components/detail/kinds/RolloutDetail';
import { ArgoApplicationActions } from '../../../client/src/components/detail/kinds/ArgoApplicationDetail';
import { FluxActions } from '../../../client/src/components/detail/kinds/FluxDetail';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useDetailStore } from '../../../client/src/state/detail';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  toast: vi.fn(),
  resources: [] as unknown[],
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  DETAIL_LIST_LIVE_MS: 5000,
  useApiResources: () => ({ data: mocks.resources }),
  useResourceList: () => ({ data: { items: [] }, isLoading: false }),
  useReferences: () => ({ data: { items: [], unavailable: [] }, isLoading: false, isError: false }),
  useUsedBy: () => ({ data: { items: [], unavailable: [] }, isLoading: false, isError: false }),
}));
vi.mock('../../../client/src/api/operator-actions.js', () => ({
  useOperatorAction: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: mocks.toast, showErrorToast: mocks.toast }));
vi.mock('../../../client/src/components/RowActions.js', () => ({
  QuickActionButton: ({ label, onClick }: { label: string; onClick: () => void }) => <button onClick={onClick}>{label}</button>,
}));

const gatewayKind: ResourceKindInfo = { group: 'gateway.networking.k8s.io', version: 'v1', plural: 'gateways', kind: 'Gateway', namespaced: true, verbs: ['list'], custom: true };

function route(): KubeObject {
  return {
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: { name: 'podinfo', namespace: 'shop', uid: 'route' },
    spec: {
      parentRefs: [{ name: 'web', sectionName: 'http' }, { name: 'edge' }],
      hostnames: ['podinfo.example.com'],
      rules: [
        { name: 'canary-testers', matches: [{ path: { type: 'PathPrefix', value: '/api' }, headers: [{ name: 'x-canary', value: 'true' }] }], backendRefs: [{ name: 'podinfo-canary', port: 9898 }] },
        { backendRefs: [{ name: 'podinfo', port: 9898, weight: 80 }, { name: 'podinfo-canary', port: 9898, weight: 20 }] },
      ],
    },
    status: {
      parents: [
        {
          parentRef: { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'web', sectionName: 'http' },
          controllerName: 'example.com/gw',
          conditions: [
            { type: 'Accepted', status: 'True', reason: 'Accepted' },
            { type: 'ResolvedRefs', status: 'False', reason: 'BackendNotFound', message: 'Service shop/podinfo-canary not found' },
          ],
        },
      ],
    },
  } as unknown as KubeObject;
}

const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'httproutes.gateway.networking.k8s.io', uid: 'crd' }, spec: { group: 'gateway.networking.k8s.io', names: { plural: 'httproutes', kind: 'HTTPRoute' } } } as unknown as KubeObject;

const tile = (label: string) => screen.getAllByRole('term').find((el) => el.textContent === label)?.nextElementSibling;

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.toast.mockReset();
  mocks.resources = [gatewayKind];
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, drafts: {}, pendingDiscard: undefined });
  useClustersStore.setState({ contextSettings: {}, selected: ['dev'] });
});

describe('CustomResourceDetail', () => {
  it('prints list printer columns as a joined list and nested condition lists per item', () => {
    const widgetCrd = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'widgets.example.io', uid: 'crd' },
      spec: {
        group: 'example.io',
        names: { plural: 'widgets', kind: 'Widget' },
        versions: [{ name: 'v1', served: true, storage: true, additionalPrinterColumns: [{ name: 'Hosts', type: 'string', jsonPath: '.spec.hosts' }] }],
      },
    } as unknown as KubeObject;
    const widget = {
      apiVersion: 'example.io/v1',
      kind: 'Widget',
      metadata: { name: 'w', namespace: 'shop', uid: 'w' },
      spec: { hosts: ['a.example.com', 'b.example.com'] },
      status: { targets: [{ name: 'east', conditions: [{ type: 'Ready', status: 'True' }] }, { name: 'west', conditions: [{ type: 'Ready', status: 'False', reason: 'Unreachable' }] }] },
    } as unknown as KubeObject;
    render(<CustomResourceDetail obj={widget} ctx="dev" crd={widgetCrd} version="v1" />);
    expect(screen.getByText('a.example.com, b.example.com')).toBeInTheDocument();
    expect(screen.getByText('Target conditions')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 healthy')).toBeInTheDocument();
    expect(screen.getByText('east')).toBeInTheDocument();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
  });
});

describe('RouteDetail', () => {
  it('shows each rule as matches to weighted backends, and every parent with its conditions', () => {
    render(<RouteDetail obj={route()} ctx="dev" crd={crd} version="v1" />);
    expect(tile('Accepted')).toHaveTextContent('1/2');
    expect(tile('Refs resolved')).toHaveTextContent('0/2');
    expect(tile('Backends')).toHaveTextContent('2');
    expect(screen.getByText('podinfo.example.com')).toBeInTheDocument();
    expect(screen.getByText('canary-testers')).toBeInTheDocument();
    expect(screen.getByText('header x-canary: true')).toBeInTheDocument();
    expect(screen.getByText('PathPrefix /')).toBeInTheDocument();
    expect(screen.getByText('80% · w80')).toBeInTheDocument();
    expect(screen.getByText('20% · w20')).toBeInTheDocument();
    // The banner explains both parents: one rejected a backend, one has no status at all.
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Gateway web · http: ResolvedRefs False (BackendNotFound)');
    expect(banner).toHaveTextContent('Service shop/podinfo-canary not found');
    expect(banner).toHaveTextContent('Gateway edge: no status yet');
    expect(screen.getByText('No controller has reported on this parent yet.')).toBeInTheDocument();

    // Parents and backends open in the drawer stack.
    fireEvent.click(screen.getByRole('button', { name: 'Gateway web · http' }));
    fireEvent.click(screen.getByRole('button', { name: 'podinfo:9898' }));
    expect(useDetailStore.getState().stack.map((s) => `${s.kind}/${s.namespace}/${s.name}:${s.custom ? 'custom' : 'builtin'}`)).toEqual(['Gateway/shop/web:custom', 'Service/shop/podinfo:builtin']);
  });
});

function rollout(status: Record<string, unknown>): KubeObject {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Rollout',
    metadata: { name: 'checkout', namespace: 'shop', uid: 'ro' },
    spec: { strategy: { canary: { steps: [{ setWeight: 20 }, { pause: {} }] } } },
    status,
  } as unknown as KubeObject;
}

const target = (obj: KubeObject, plural: string) => ({ ctx: 'dev', group: obj.apiVersion!.split('/')[0]!, version: obj.apiVersion!.split('/')[1]!, plural, obj });

describe('operator actions', () => {
  it('confirms a promote before patching, with the action named for the rollout', () => {
    const paused = rollout({ phase: 'Paused', currentPodHash: 'new', stableRS: 'old', currentStepIndex: 1, pauseConditions: [{ reason: 'CanaryPauseStep' }] });
    render(<RolloutActions {...target(paused, 'rollouts')} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Promote', 'Promote full', 'Abort']);
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { ctx: 'dev', body: { action: 'rollout-promote', group: 'argoproj.io', version: 'v1alpha1', plural: 'rollouts', namespace: 'shop', name: 'checkout' } },
      expect.anything(),
    );
  });

  it('offers only Retry after an abort, and wants the name typed on a protected cluster', () => {
    useClustersStore.setState({ contextSettings: { dev: { protected: true } } });
    render(<RolloutActions {...target(rollout({ abort: true, currentPodHash: 'new', stableRS: 'old' }), 'rollouts')} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Retry']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(screen.getByRole('dialog')).getByPlaceholderText('checkout'), { target: { value: 'checkout' } });
    fireEvent.click(confirm);
    expect(mocks.mutate.mock.calls[0]![0].body.action).toBe('rollout-retry');
  });

  it('refreshes an Application at once and syncs it after confirming, with prune when ticked', () => {
    const app = {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name: 'guestbook', namespace: 'argocd', uid: 'app' },
      spec: { source: { targetRevision: 'main' } },
    } as unknown as KubeObject;
    render(<ArgoApplicationActions {...target(app, 'applications')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocks.mutate.mock.calls[0]![0].body).toMatchObject({ action: 'argocd-refresh', name: 'guestbook' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Apply main to the cluster now');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync and prune' }));
    expect(mocks.mutate.mock.calls[1]![0].body).toMatchObject({ action: 'argocd-sync', prune: true });
  });

  it('switches Flux between Suspend and Resume with the object state', () => {
    const ks = (suspend: boolean) =>
      ({ apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization', metadata: { name: 'apps', namespace: 'flux-system', uid: 'ks' }, spec: { suspend } }) as unknown as KubeObject;
    const { unmount } = render(<FluxActions {...target(ks(false), 'kustomizations')} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Reconcile', 'Suspend']);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
    expect(mocks.mutate.mock.calls[0]![0].body).toMatchObject({ action: 'flux-reconcile', plural: 'kustomizations' });
    unmount();
    render(<FluxActions {...target(ks(true), 'kustomizations')} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Reconcile', 'Resume']);
  });
});

describe('ArgoApplicationDetail', () => {
  it('links managed resources only when the app deploys into this cluster', async () => {
    const { ArgoApplicationDetail } = await import('../../../client/src/components/detail/kinds/ArgoApplicationDetail');
    mocks.resources = [{ group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['list'] }];
    const app = (server: string) =>
      ({
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: { name: 'guestbook', namespace: 'argocd', uid: `app-${server}` },
        spec: { destination: { server, namespace: 'web' } },
        status: { resources: [{ group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'web', name: 'ui', status: 'Synced', health: { status: 'Healthy' } }] },
      }) as unknown as KubeObject;
    const appCrd = { ...crd, spec: { group: 'argoproj.io', names: { plural: 'applications', kind: 'Application' } } } as unknown as KubeObject;
    const local = render(<ArgoApplicationDetail obj={app('https://kubernetes.default.svc')} ctx="dev" crd={appCrd} version="v1alpha1" />);
    expect(screen.getByRole('button', { name: 'web/ui' })).toBeInTheDocument();
    local.unmount();
    render(<ArgoApplicationDetail obj={app('https://prod.example.com:6443')} ctx="dev" crd={appCrd} version="v1alpha1" />);
    expect(screen.queryByRole('button', { name: 'web/ui' })).not.toBeInTheDocument();
    expect(screen.getByText('web/ui')).toBeInTheDocument();
    expect(screen.getByText('in https://prod.example.com:6443')).toBeInTheDocument();
  });
});

