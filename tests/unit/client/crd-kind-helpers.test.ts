import { describe, expect, it } from 'vitest';
import type { KubeObject, ResourceKindInfo } from '@kubus/shared';
import { conditionGroupTitle, nestedConditionGroups } from '../../../client/src/components/detail/nested-conditions';
import {
  describeFilter,
  describeGrpcMatch,
  describeHttpMatch,
  listenerRows,
  routeAttachesTo,
  routeParents,
  ruleBackends,
  ruleMatches,
} from '../../../client/src/components/detail/kinds/gateway-api';
import { canaryWeight, describeStep, imageRows, rolloutActions, rolloutHeaderStatus, stepState } from '../../../client/src/components/detail/kinds/argo-rollouts';
import { appDeploysInCluster, appProblems, appSyncPolicy, shortRevision, sortedResources } from '../../../client/src/components/detail/kinds/argo-cd';
import { fluxHeaderStatus, helmReleaseState, inventory, parseInventoryEntry } from '../../../client/src/components/detail/kinds/flux';
import { customKindEntry } from '../../../client/src/components/detail/kinds/registry';
import { resolveKind } from '../../../client/src/components/detail/kinds/links';
import { gitopsNavKinds } from '../../../client/src/layout/gitops-nav';

const obj = (fields: Record<string, unknown>, namespace = 'shop'): KubeObject => ({ apiVersion: 'x/v1', kind: 'X', metadata: { name: 'x', namespace, uid: 'u' }, ...fields }) as KubeObject;
const cond = (type: string, status: string, reason?: string) => ({ type, status, reason, message: `${type} is ${status}` });

describe('nested condition groups', () => {
  it('finds per-item condition lists and labels each item by what identifies it', () => {
    const groups = nestedConditionGroups(
      {
        conditions: [cond('Ready', 'True')],
        parents: [
          { parentRef: { name: 'web', sectionName: 'https' }, controllerName: 'example.com/gw', conditions: [cond('Accepted', 'True')] },
          { parentRef: { name: 'edge', namespace: 'infra', kind: 'Gateway', port: 443 }, conditions: [cond('Accepted', 'False', 'NotAllowedByListeners')] },
        ],
        listeners: [{ name: 'http', attachedRoutes: 1, conditions: [cond('Programmed', 'True')] }, { attachedRoutes: 0 }],
        addresses: [{ value: '10.0.0.1' }],
      },
      'shop',
    );
    expect(groups.map((g) => [g.field, g.title, g.owners.map((o) => o.label)])).toEqual([
      ['parents', 'Parent conditions', ['Gateway web · https', 'Gateway infra/edge :443']],
      ['listeners', 'Listener conditions', ['http']],
    ]);
    expect(groups[0]!.owners[0]!.detail).toBe('example.com/gw');
    expect(nestedConditionGroups(undefined)).toEqual([]);
    expect(conditionGroupTitle('attachedPolicies')).toBe('Attached policy conditions');
  });
});

describe('Gateway API reading', () => {
  it('describes HTTP and gRPC matches clause by clause, with spec defaults', () => {
    expect(describeHttpMatch({ path: { value: '/api' }, headers: [{ name: 'x-canary', value: 'true' }, { type: 'RegularExpression', name: 'x-v', value: '^2' }], queryParams: [{ name: 'q', value: '1' }], method: 'GET' })).toEqual([
      'PathPrefix /api',
      'method GET',
      'header x-canary: true',
      'header x-v ~ ^2',
      'query q: 1',
    ]);
    expect(describeGrpcMatch({ method: { service: 'shop.Checkout', method: 'Place' } })).toEqual(['method shop.Checkout/Place']);
    expect(describeGrpcMatch({})).toEqual(['any method']);
    expect(ruleMatches({}, 'http')).toEqual([['PathPrefix /']]);
    expect(ruleMatches({ matches: [{ path: { type: 'Exact', value: '/a' } }] }, 'stream')).toEqual([['all connections']]);
  });

  it('shares traffic by weight and defaults backends to core Services in the route namespace', () => {
    expect(ruleBackends({ backendRefs: [{ name: 'stable', port: 80, weight: 80 }, { name: 'canary', port: 80, weight: 20 }, { name: 'ext', kind: 'ServiceImport', group: 'multicluster.x-k8s.io', namespace: 'other' }] }, 'shop')).toEqual([
      { group: '', kind: 'Service', name: 'stable', namespace: 'shop', port: 80, weight: 80, share: 79 },
      { group: '', kind: 'Service', name: 'canary', namespace: 'shop', port: 80, weight: 20, share: 20 },
      { group: 'multicluster.x-k8s.io', kind: 'ServiceImport', name: 'ext', namespace: 'other', port: undefined, weight: 1, share: 1 },
    ]);
    expect(ruleBackends({ backendRefs: [{ name: 'off', weight: 0 }] }, 'shop')[0]!.share).toBeUndefined();
  });

  it('describes filters in one line each', () => {
    expect(describeFilter({ type: 'RequestHeaderModifier', requestHeaderModifier: { set: [{ name: 'x-a', value: '1' }], remove: ['x-b'] } })).toBe('Request headers: set x-a: 1, remove x-b');
    expect(describeFilter({ type: 'URLRewrite', urlRewrite: { path: { type: 'ReplacePrefixMatch', replacePrefixMatch: '/v2' } } })).toBe('Rewrite prefix → /v2');
    expect(describeFilter({ type: 'RequestRedirect', requestRedirect: { scheme: 'https', statusCode: 301 } })).toBe('Redirect to https:// 301');
  });

  it('joins spec parents with the status each controller wrote, keeping status-only parents', () => {
    const route = obj({
      kind: 'HTTPRoute',
      spec: { parentRefs: [{ name: 'web', sectionName: 'http' }, { name: 'web', sectionName: 'https' }] },
      status: {
        parents: [
          { parentRef: { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'web', sectionName: 'https' }, controllerName: 'c', conditions: [cond('Accepted', 'True')] },
          { parentRef: { name: 'old' }, controllerName: 'c', conditions: [cond('Accepted', 'False')] },
        ],
      },
    });
    const parents = routeParents(route);
    expect(parents.map((p) => [p.label, p.statuses.length])).toEqual([
      ['Gateway web · http', 0],
      ['Gateway web · https', 1],
      ['Gateway old', 1],
    ]);
    expect(routeAttachesTo(route, { name: 'web', namespace: 'shop' })).toBe(true);
    expect(routeAttachesTo(route, { name: 'web', namespace: 'other' })).toBe(false);
  });

  it('joins listeners with their status by name', () => {
    const gw = obj({
      spec: { listeners: [{ name: 'https', protocol: 'HTTPS', port: 443, tls: { certificateRefs: [{ name: 'tls' }] }, allowedRoutes: { namespaces: { from: 'All' } } }] },
      status: { listeners: [{ name: 'https', attachedRoutes: 2, supportedKinds: [{ kind: 'HTTPRoute' }], conditions: [cond('Programmed', 'True')] }] },
    });
    expect(listenerRows(gw)).toEqual([
      {
        name: 'https',
        protocol: 'HTTPS',
        port: 443,
        hostname: undefined,
        tlsMode: 'Terminate',
        certificates: [{ group: '', kind: 'Secret', name: 'tls', namespace: undefined }],
        namespaces: 'All namespaces',
        kinds: ['HTTPRoute'],
        attachedRoutes: 2,
        conditions: [{ type: 'Programmed', status: 'True', reason: undefined, message: 'Programmed is True', lastTransitionTime: undefined }],
      },
    ]);
  });
});

describe('Argo Rollouts reading', () => {
  const steps = [{ setWeight: 20 }, { pause: {} }, { setWeight: 50 }, { pause: { duration: '10m' } }, { analysis: { templates: [{ templateName: 'success-rate' }] } }];
  const rollout = (status: Record<string, unknown>, spec: Record<string, unknown> = {}) => obj({ spec: { strategy: { canary: { steps } }, ...spec }, status });

  it('describes canary steps', () => {
    expect(steps.map((s) => describeStep(s))).toEqual([
      { title: 'Set weight', detail: '20%' },
      { title: 'Pause', detail: 'until promoted' },
      { title: 'Set weight', detail: '50%' },
      { title: 'Pause', detail: '10m' },
      { title: 'Analysis', detail: 'success-rate' },
    ]);
    expect(describeStep({ setCanaryScale: { replicas: 2 } })).toEqual({ title: 'Scale canary', detail: '2 replicas' });
  });

  it('offers promote, promote full and abort during an update, retry after an abort', () => {
    const paused = rollout({ phase: 'Paused', currentPodHash: 'new', stableRS: 'old', currentStepIndex: 1, pauseConditions: [{ reason: 'CanaryPauseStep' }] });
    expect(rolloutActions(paused)).toEqual({ promote: true, promoteFull: true, abort: true, retry: false });
    expect(rolloutActions(rollout({ phase: 'Healthy', currentPodHash: 'same', stableRS: 'same' }))).toEqual({ promote: false, promoteFull: false, abort: false, retry: false });
    const aborted = rollout({ abort: true, currentPodHash: 'new', stableRS: 'old', phase: 'Degraded' });
    expect(rolloutActions(aborted)).toEqual({ promote: false, promoteFull: false, abort: false, retry: true });
    expect(rolloutHeaderStatus(aborted)).toBe('Aborted');
  });

  it('marks steps done, current and pending, and reads the canary weight', () => {
    const paused = rollout({ currentPodHash: 'new', stableRS: 'old', currentStepIndex: 1 });
    expect(steps.map((_, i) => stepState(i, paused))).toEqual(['done', 'current', 'pending', 'pending', 'pending']);
    expect(canaryWeight(paused)).toBe(20);
    const healthy = rollout({ currentPodHash: 'same', stableRS: 'same', currentStepIndex: 5 });
    expect(steps.map((_, i) => stepState(i, healthy))).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(canaryWeight(healthy)).toBe(0);
    expect(canaryWeight(rollout({ canary: { weights: { canary: { weight: 35 } } } }))).toBe(35);
  });

  it('lines up stable and canary images by container', () => {
    expect(imageRows([{ name: 'app', image: 'a:1' }, { name: 'proxy', image: 'p:1' }], [{ name: 'app', image: 'a:2' }, { name: 'proxy', image: 'p:1' }])).toEqual([
      { container: 'app', stable: 'a:1', canary: 'a:2', changed: true },
      { container: 'proxy', stable: 'p:1', canary: 'p:1', changed: false },
    ]);
  });
});

describe('Argo CD reading', () => {
  it('reads the sync policy flags, including an explicitly disabled automation', () => {
    expect(appSyncPolicy(obj({ spec: { syncPolicy: { automated: { prune: true }, syncOptions: ['CreateNamespace=true'] } } }))).toEqual({ auto: true, prune: true, selfHeal: false, options: ['CreateNamespace=true'] });
    expect(appSyncPolicy(obj({ spec: { syncPolicy: { automated: { enabled: false, prune: true } } } }))).toMatchObject({ auto: false, prune: false });
    expect(appSyncPolicy(obj({ spec: {} }))).toMatchObject({ auto: false });
  });

  it('lists what needs attention and sorts troubled resources first', () => {
    const app = obj({
      status: {
        conditions: [{ type: 'ComparisonError', message: 'repo unreachable' }],
        health: { status: 'Degraded', message: 'deployment down' },
        operationState: { phase: 'Failed', message: 'hook failed' },
        resources: [
          { kind: 'Service', name: 'web', status: 'Synced', health: { status: 'Healthy' } },
          { kind: 'Deployment', name: 'web', status: 'OutOfSync', health: { status: 'Degraded', message: 'progress deadline' } },
          { kind: 'ConfigMap', name: 'cfg', status: 'OutOfSync', health: { status: 'Missing' } },
        ],
      },
    });
    expect(appProblems(app).map((p) => p.title)).toEqual(['ComparisonError', 'Last sync failed', 'Degraded', '1 resource degraded', '1 resource missing']);
    expect(sortedResources(app).map((r) => r.kind)).toEqual(['Deployment', 'ConfigMap', 'Service']);
    expect(shortRevision('4f3c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a')).toBe('4f3c2a9');
    expect(shortRevision('v1.2.3')).toBe('v1.2.3');
    // Only an in-cluster destination makes the managed resources objects of this cluster.
    expect(appDeploysInCluster(obj({ spec: { destination: { server: 'https://kubernetes.default.svc/', namespace: 'x' } } }))).toBe(true);
    expect(appDeploysInCluster(obj({ spec: { destination: { name: 'in-cluster' } } }))).toBe(true);
    expect(appDeploysInCluster(obj({ spec: { destination: { server: 'https://prod.example.com:6443' } } }))).toBe(false);
    expect(appDeploysInCluster(obj({ spec: { destination: { name: 'prod' } } }))).toBe(false);
  });
});

describe('Flux reading', () => {
  it('parses inventory ids for namespaced, cluster-scoped and core objects', () => {
    expect(parseInventoryEntry('apps_web_apps_Deployment', 'v1')).toEqual({ namespace: 'apps', name: 'web', group: 'apps', kind: 'Deployment', version: 'v1' });
    expect(parseInventoryEntry('_apps__Namespace')).toEqual({ namespace: undefined, name: 'apps', group: '', kind: 'Namespace', version: undefined });
    expect(parseInventoryEntry('garbage')).toBeUndefined();
    // cli-utils writes a name's colons as `__`.
    expect(parseInventoryEntry('_metrics-server__system__auth-delegator_rbac.authorization.k8s.io_ClusterRoleBinding', 'v1')).toEqual({
      namespace: undefined,
      name: 'metrics-server:system:auth-delegator',
      group: 'rbac.authorization.k8s.io',
      kind: 'ClusterRoleBinding',
      version: 'v1',
    });
    expect(parseInventoryEntry('kube-system_system__auth__Role')).toEqual({ namespace: 'kube-system', name: 'system:auth', group: '', kind: 'Role', version: undefined });
    expect(inventory(obj({ status: { inventory: { entries: [{ id: 'a_z__Service', v: 'v1' }, { id: 'a_b_apps_Deployment', v: 'v1' }] } } })).map((e) => e.kind)).toEqual(['Deployment', 'Service']);
  });

  it('finds the Helm release in the storage namespace on v2, and the latest release on v2beta1', () => {
    const hr = (spec: Record<string, unknown>, status: Record<string, unknown>) =>
      ({ apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease', metadata: { name: 'kube-prometheus', namespace: 'flux-system', uid: 'hr' }, spec, status }) as unknown as KubeObject;
    const v2 = helmReleaseState(
      hr(
        { targetNamespace: 'monitoring', chart: { spec: { chart: 'kube-prometheus-stack' } } },
        { history: [{ name: 'monitoring-kube-prometheus', namespace: 'monitoring', version: 4, chartName: 'kube-prometheus-stack', chartVersion: '58.1.0', appVersion: 'v0.73.0' }] },
      ),
    );
    // Helm keeps the release where the HelmRelease lives, not in its target namespace.
    expect(v2).toMatchObject({ installed: true, revision: 4, releaseName: 'monitoring-kube-prometheus', storageNamespace: 'flux-system', chartVersion: '58.1.0', latestOnly: false });
    expect(helmReleaseState(hr({}, { storageNamespace: 'helm-store', history: [{ version: 1 }] })).storageNamespace).toBe('helm-store');

    const v2beta1 = helmReleaseState(hr({ targetNamespace: 'monitoring', chart: { spec: { chart: 'kube-prometheus-stack' } } }, { lastReleaseRevision: 7, lastAppliedRevision: '57.0.0' }));
    expect(v2beta1).toMatchObject({ installed: true, revision: 7, chartName: 'kube-prometheus-stack', chartVersion: '57.0.0', releaseName: 'monitoring-kube-prometheus', latestOnly: true });
    expect(v2beta1.history).toHaveLength(1);
    expect(helmReleaseState(hr({}, {}))).toMatchObject({ installed: false, history: [] });
  });

  it('puts suspension and stalls ahead of the Ready condition in the header word', () => {
    expect(fluxHeaderStatus(obj({ spec: { suspend: true }, status: { conditions: [cond('Ready', 'True')] } }))).toBe('Suspended');
    expect(fluxHeaderStatus(obj({ status: { conditions: [cond('Ready', 'False'), cond('Stalled', 'True')] } }))).toBe('Stalled');
    expect(fluxHeaderStatus(obj({ status: { conditions: [cond('Ready', 'Unknown')] } }))).toBe('Progressing');
    expect(fluxHeaderStatus(obj({ status: {} }))).toBeUndefined();
  });
});

describe('custom kind registry', () => {
  it('picks views by group and kind, and gives every Flux kind its actions', () => {
    expect(customKindEntry('gateway.networking.k8s.io/v1', 'HTTPRoute')?.view).toBeDefined();
    expect(customKindEntry('gateway.networking.k8s.io/v1beta1', 'GRPCRoute')?.view).toBe(customKindEntry('gateway.networking.k8s.io/v1', 'HTTPRoute')?.view);
    expect(customKindEntry('argoproj.io/v1alpha1', 'Rollout')?.actions).toBeDefined();
    expect(customKindEntry('cert-manager.io/v1', 'Certificate')?.view).toBeDefined();
    const source = customKindEntry('source.toolkit.fluxcd.io/v1', 'GitRepository');
    expect(source?.view).toBeUndefined();
    expect(source?.actions).toBeDefined();
    expect(customKindEntry('example.io/v1', 'HTTPRoute')).toBeUndefined();
    // ImagePolicy has no spec.suspend, so no Flux actions.
    expect(customKindEntry('image.toolkit.fluxcd.io/v1beta2', 'ImagePolicy')).toBeUndefined();
    expect(customKindEntry('v1', 'Service')).toBeUndefined();
  });
});

const kind = (group: string, version: string, plural: string, kindName: string): ResourceKindInfo => ({ group, version, plural, kind: kindName, namespaced: true, verbs: ['list', 'get'], custom: true });

describe('GitOps nav and kind resolution', () => {
  it('shows the GitOps kinds only once Argo CD or Flux is installed', () => {
    const rolloutsOnly = [kind('argoproj.io', 'v1alpha1', 'rollouts', 'Rollout')];
    expect(gitopsNavKinds(rolloutsOnly)).toEqual([]);
    const argo = [...rolloutsOnly, kind('argoproj.io', 'v1alpha1', 'appprojects', 'AppProject'), kind('argoproj.io', 'v1alpha1', 'applications', 'Application')];
    expect(gitopsNavKinds(argo).map((k) => k.kind)).toEqual(['Application', 'AppProject']);
    const flux = [
      kind('source.toolkit.fluxcd.io', 'v1beta2', 'ocirepositories', 'OCIRepository'),
      kind('source.toolkit.fluxcd.io', 'v1', 'ocirepositories', 'OCIRepository'),
      kind('kustomize.toolkit.fluxcd.io', 'v1', 'kustomizations', 'Kustomization'),
    ];
    expect(gitopsNavKinds(flux).map((k) => `${k.kind}@${k.version}`)).toEqual(['Kustomization@v1', 'OCIRepository@v1']);
  });

  it('resolves a named kind to the served version, builtins without discovery', () => {
    expect(resolveKind(undefined, '', 'Service')).toMatchObject({ plural: 'services', version: 'v1' });
    const served = [kind('gateway.networking.k8s.io', 'v1beta1', 'gateways', 'Gateway'), kind('gateway.networking.k8s.io', 'v1', 'gateways', 'Gateway')];
    expect(resolveKind(served, 'gateway.networking.k8s.io', 'Gateway')).toMatchObject({ version: 'v1' });
    expect(resolveKind(served, 'other.io', 'Gateway')).toBeUndefined();
  });
});
