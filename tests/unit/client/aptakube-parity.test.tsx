import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject, UsedByEntry } from '@kubus/shared';
import { matchesMiniFilter } from '../../../client/src/components/MiniFilterInput';
import { safeHref } from '../../../client/src/components/detail/GenericDetail';
import { describePeer, describePorts, effectivePolicyTypes, selectsAll } from '../../../client/src/components/detail/NetworkPolicyDetail';
import { pdbBlocksEvictions, pdbCoverage, pdbRule } from '../../../client/src/components/detail/PodDisruptionBudgetDetail';
import { quotaRows } from '../../../client/src/components/detail/ResourceQuotaDetail';
import { limitResources } from '../../../client/src/components/detail/LimitRangeDetail';
import { quotaLinksFor, quotaNamesIn } from '../../../client/src/components/detail/quota-link';
import { labelSelectorMatches, labelSelectorToString } from '../../../client/src/components/detail/selectors';
import { ReferencesSection, UsedBySection, usedBySummary } from '../../../client/src/components/detail/UsedBySection';
import { withIdentity } from '../../../client/src/api/queries';
import { makeSignalsLookup } from '../../../client/src/components/columns';
import { tabSelection } from '../../../client/src/layout/TabHealthWatcher';
import { namespacesForContexts, useClustersStore } from '../../../client/src/state/clusters';
import { useDetailStore } from '../../../client/src/state/detail';
import { useDockStore } from '../../../client/src/state/dock';
import { useUiPrefsStore } from '../../../client/src/state/prefs';
import { useTabAttentionStore } from '../../../client/src/state/tab-attention';
import { TabHealthWatchers } from '../../../client/src/layout/TabHealthWatcher';

const watch = vi.hoisted(() => ({ handlers: [] as Array<{ onSnapshot: (items: unknown[]) => void; onEvents: (events: unknown[]) => void }> }));
vi.mock('../../../client/src/api/ws/watch-client.js', () => ({
  watchClient: {
    subscribe: (_params: unknown, handlers: { onSnapshot: (items: unknown[]) => void; onEvents: (events: unknown[]) => void }) => {
      watch.handlers.push(handlers);
      return () => undefined;
    },
    onBroadcast: () => () => undefined,
  },
}));

const queries = vi.hoisted(() => ({
  usedBy: undefined as { items: UsedByEntry[]; unavailable: string[]; partial?: string[]; truncated: number } | undefined,
  references: undefined as { items: UsedByEntry[]; unavailable: string[] } | undefined,
  error: undefined as Error | undefined,
}));

vi.mock('../../../client/src/api/queries.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/src/api/queries.js')>()),
  useUsedBy: () => ({ data: queries.usedBy, isLoading: !queries.usedBy && !queries.error, isError: !!queries.error, error: queries.error }),
  useReferences: () => ({ data: queries.references, isLoading: !queries.references && !queries.error, isError: !!queries.error, error: queries.error }),
}));

function entry(kind: string, name: string, relation: string, detail?: string, namespace = 'apps'): UsedByEntry {
  return { ref: { ctx: 'kind-a', group: kind === 'Deployment' ? 'apps' : '', version: 'v1', plural: `${kind.toLowerCase()}s`, kind, name, namespace }, relation, detail };
}

beforeEach(() => {
  watch.handlers.length = 0;
  useTabAttentionStore.setState({ attention: {} });
  queries.usedBy = undefined;
  queries.references = undefined;
  queries.error = undefined;
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, drafts: {}, pendingDiscard: undefined });
  useDockStore.setState({ tabs: [], activeId: undefined, open: false, maximized: false, terminalFocusRequest: undefined, terminalReconnectRequests: {} });
  useClustersStore.setState({ selected: [], namespaces: [], namespacesByContext: {} });
  useUiPrefsStore.setState({ listState: {} });
});

describe('TabHealthWatchers', () => {
  const pod = (phase: string, ready: boolean): KubeObject =>
    ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-1', namespace: 'apps', uid: 'p1' },
      spec: { containers: [{ name: 'app' }] },
      status: { phase, containerStatuses: [{ name: 'app', ready, restartCount: 0, state: ready ? { running: { startedAt: '2026-09-04T00:00:00Z' } } : { terminated: { reason: 'Error' } } }] },
    }) as KubeObject;
  const tab = { id: 't1', path: '/r/core/v1/pods?sel=kind-a|apps|web-1' };

  it('judges a background change against the health last seen in front, even without an event in between', () => {
    const { rerender } = render(<TabHealthWatchers tabs={[tab]} activeId="t1" />);
    const handlers = watch.handlers.at(-1)!;
    act(() => handlers.onSnapshot([pod('Running', true)]));
    expect(useTabAttentionStore.getState().attention.t1).toBeUndefined();

    // The user switches away; the object stays quiet until it fails.
    rerender(<TabHealthWatchers tabs={[tab]} activeId="other" />);
    act(() => handlers.onEvents([{ type: 'MODIFIED', object: pod('Failed', false) }]));
    expect(useTabAttentionStore.getState().attention.t1?.reason).toBe('Pod web-1 became unhealthy while you were away');

    // Coming back clears the mark. The user then watches it recover, leaves,
    // and the deletion of a pod last seen healthy is worth a mark again.
    rerender(<TabHealthWatchers tabs={[tab]} activeId="t1" />);
    expect(useTabAttentionStore.getState().attention.t1).toBeUndefined();
    act(() => handlers.onEvents([{ type: 'MODIFIED', object: pod('Running', true) }]));
    rerender(<TabHealthWatchers tabs={[tab]} activeId="other" />);
    act(() => handlers.onEvents([{ type: 'DELETED', object: pod('Running', true) }]));
    expect(useTabAttentionStore.getState().attention.t1?.reason).toBe('Pod web-1 was deleted while you were away');
  });

  it('takes the first sighting as the starting point for a tab that was never in front', () => {
    render(<TabHealthWatchers tabs={[tab]} activeId="other" />);
    const handlers = watch.handlers.at(-1)!;
    act(() => handlers.onSnapshot([pod('Failed', false)]));
    expect(useTabAttentionStore.getState().attention.t1).toBeUndefined();
    act(() => handlers.onEvents([{ type: 'MODIFIED', object: pod('Running', true) }]));
    act(() => handlers.onEvents([{ type: 'MODIFIED', object: pod('Failed', false) }]));
    expect(useTabAttentionStore.getState().attention.t1?.reason).toBe('Pod web-1 became unhealthy while you were away');
  });
});

describe('pdbCoverage', () => {
  it('tells an empty selector (every pod) from a missing one (nothing)', () => {
    expect(pdbCoverage({ selector: { matchLabels: { app: 'web' } } })).toEqual({ selectorText: 'app=web', selectsAll: false, covers: true });
    expect(pdbCoverage({ selector: {} })).toEqual({ selectorText: '', selectsAll: true, covers: true });
    expect(pdbCoverage({})).toEqual({ selectorText: '', selectsAll: false, covers: false });
  });
});

describe('withIdentity', () => {
  it('restores apiVersion and kind on objects mirrored off the watch stream, identity first', () => {
    const listed = { metadata: { name: 'web', namespace: 'apps', uid: 'u' }, spec: { replicas: 2 } } as KubeObject;
    const restored = withIdentity(listed, { group: 'apps', version: 'v1', kind: 'Deployment' });
    expect(Object.keys(restored)).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
    expect(restored).toMatchObject({ apiVersion: 'apps/v1', kind: 'Deployment' });
    expect(withIdentity({ ...listed, apiVersion: 'v1' }, { group: '', version: 'v1', kind: 'ConfigMap' })).toMatchObject({ apiVersion: 'v1', kind: 'ConfigMap' });
    // A complete object passes through untouched; without a kind to restore, only the apiVersion is filled.
    const full = { apiVersion: 'v1', kind: 'Pod', ...listed };
    expect(withIdentity(full, { group: '', version: 'v1' })).toBe(full);
    expect(withIdentity(listed, { group: '', version: 'v1' })).toEqual({ apiVersion: 'v1', ...listed });
  });
});

describe('UsedBySection', () => {
  const target = { ctx: 'kind-a', group: '', version: 'v1', plural: 'configmaps', kind: 'ConfigMap', name: 'app-config', namespace: 'apps' };

  it('summarizes referrers by kind, lists how each one uses the object, and opens rows in the drawer', () => {
    queries.usedBy = {
      items: [entry('Deployment', 'web', 'mounts · env', 'volume cfg, app: MODE'), entry('Deployment', 'api', 'env', 'api: all keys'), entry('Pod', 'job-1', 'mounts', 'volume cfg')],
      unavailable: ['CronJob'],
      truncated: 0,
    };
    render(<UsedBySection target={target} />);
    expect(screen.getByText('2 Deployments · 1 Pod')).toBeInTheDocument();
    expect(screen.getByText('volume cfg, app: MODE')).toBeInTheDocument();
    expect(screen.getByText(/CronJobs could not be read/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'web' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Deployment', name: 'web', namespace: 'apps', plural: 'deployments', custom: false });
  });

  it('filters long lists and explains empty and failed lookups', () => {
    queries.usedBy = { items: Array.from({ length: 8 }, (_, i) => entry('Pod', `pod-${i}`, 'mounts')), unavailable: [], truncated: 3 };
    render(<UsedBySection target={target} />);
    expect(screen.getByText('3 more not shown.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'pod-7' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);

    queries.usedBy = { items: [], unavailable: [], truncated: 0 };
    render(<UsedBySection target={target} emptyText="Nothing uses it." />);
    // Once in the collapsed summary line, once in the open body.
    expect(screen.getAllByText('Nothing uses it.')).toHaveLength(2);

    queries.usedBy = undefined;
    queries.error = new Error('forbidden');
    render(<UsedBySection target={target} />);
    expect(screen.getByText(/Could not resolve references: forbidden/)).toBeInTheDocument();
  });

  it('shows kinds still being indexed and, for forward references, dangling targets without a link', () => {
    queries.usedBy = { items: [entry('TopoLink', 'a', 'references', 'spec.links.local.node')], unavailable: [], partial: ['Interface', 'TopoLink', 'Fabric', 'Router'], truncated: 0 };
    render(<UsedBySection target={target} />);
    expect(screen.getByText('Still reading Interfaces, TopoLinks, Fabrics and 1 more kinds…')).toBeInTheDocument();

    queries.references = { items: [entry('TopoNode', 'l001', 'references', 'spec.links.local.node'), { ...entry('TopoNode', 'ghost', 'references', 'spec.links.remote.node'), missing: true }], unavailable: [] };
    render(<ReferencesSection target={{ ...target, kind: 'TopoLink' }} />);
    expect(screen.getByRole('button', { name: 'l001' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ghost' })).not.toBeInTheDocument();
    expect(screen.getByText('ghost')).toBeInTheDocument();
    expect(screen.getByText('not found')).toBeInTheDocument();
    expect(screen.getAllByText('2 TopoNodes')).not.toHaveLength(0);
  });

  it('restricts to the requested kinds', () => {
    queries.usedBy = { items: [entry('Ingress', 'public', 'routes to', 'app.example.com/'), entry('Pod', 'p', 'mounts')], unavailable: [], truncated: 0 };
    render(<UsedBySection target={{ ...target, kind: 'Service', plural: 'services' }} title="Routed by" kinds={['Ingress']} />);
    expect(screen.getByText('Routed by')).toBeInTheDocument();
    expect(screen.getByText('public')).toBeInTheDocument();
    expect(screen.queryByText('p')).not.toBeInTheDocument();
    expect(usedBySummary([entry('Ingress', 'a', 'x'), entry('Ingress', 'b', 'x')])).toBe('2 Ingresses');
  });
});

describe('detail helpers', () => {
  it('describes network policy peers, ports and effective types', () => {
    expect(describePeer({ podSelector: { matchLabels: { app: 'web' } } })).toBe('pods app=web in this namespace');
    expect(describePeer({ podSelector: {}, namespaceSelector: { matchLabels: { team: 'a' } } })).toBe('all pods in namespaces team=a');
    expect(describePeer({ namespaceSelector: {} })).toBe('all pods in any namespace');
    expect(describePeer({ ipBlock: { cidr: '10.0.0.0/8', except: ['10.0.1.0/24'] } })).toBe('10.0.0.0/8 except 10.0.1.0/24');
    expect(describePeer({})).toBe('anywhere');
    expect(describePorts(undefined)).toBe('all ports');
    expect(describePorts([{ port: 80 }, { port: 8000, endPort: 8080, protocol: 'UDP' }])).toBe('80/TCP, 8000–8080/UDP');
    expect(effectivePolicyTypes({})).toEqual(['Ingress']);
    expect(effectivePolicyTypes({ egress: [] })).toEqual(['Ingress', 'Egress']);
    expect(effectivePolicyTypes({ policyTypes: ['Egress'] })).toEqual(['Egress']);
    expect(selectsAll({})).toBe(true);
    expect(selectsAll({ matchLabels: { a: 'b' } })).toBe(false);
  });

  it('reads budgets, quotas and limit ranges', () => {
    expect(pdbRule({ minAvailable: 2 })).toBe('at least 2 available');
    expect(pdbRule({ maxUnavailable: '25%' })).toBe('at most 25% unavailable');
    expect(pdbBlocksEvictions({ expectedPods: 3, disruptionsAllowed: 0 })).toBe(true);
    expect(pdbBlocksEvictions({ expectedPods: 0, disruptionsAllowed: 0 })).toBe(false);
    const quota = { metadata: { name: 'q', uid: 'q' }, status: { hard: { pods: '10', 'requests.cpu': '2', 'count/secrets': '0' }, used: { pods: '10', 'requests.cpu': '500m' } } } as unknown as KubeObject;
    expect(quotaRows(quota)).toEqual([
      { resource: 'pods', used: '10', hard: '10', pct: 100 },
      { resource: 'requests.cpu', used: '500m', hard: '2', pct: 25 },
      { resource: 'count/secrets', used: '0', hard: '0', pct: undefined },
    ]);
    expect(limitResources({ type: 'Container', default: { memory: '1Gi', cpu: '1' }, max: { 'ephemeral-storage': '2Gi' } })).toEqual(['cpu', 'memory', 'ephemeral-storage']);
  });

  it('links the quota an API error names', () => {
    const message = 'pods "web-abc" is forbidden: exceeded quota: team-quota, requested: pods=1, used: pods=8, limited: pods=8; exceeded quota: cpu-quota, requested: cpu=1';
    expect(quotaNamesIn(message)).toEqual(['team-quota', 'cpu-quota']);
    const opened: string[] = [];
    const links = quotaLinksFor(message, 'apps', (selection) => opened.push(selection('kind-a').name));
    expect(links?.map((l) => l.label)).toEqual(['Open ResourceQuota team-quota', 'Open ResourceQuota cpu-quota']);
    links?.[1]?.onClick();
    expect(opened).toEqual(['cpu-quota']);
    expect(quotaLinksFor('nothing here', 'apps', () => {})).toBeUndefined();
    expect(quotaLinksFor(message, undefined, () => {})).toBeUndefined();
  });

  it('formats and evaluates label selectors', () => {
    expect(labelSelectorToString({ matchLabels: { app: 'web' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }, { key: 'legacy', operator: 'DoesNotExist' }] })).toBe('app=web,tier in (a,b),!legacy');
    expect(labelSelectorMatches({ matchLabels: { app: 'web' } }, { app: 'web' })).toBe(true);
    expect(labelSelectorMatches({ matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['x'] }] }, {})).toBe(true);
  });

  it('linkifies URL values and bare hosts under link-shaped annotation keys', () => {
    expect(safeHref('https://argocd.example.com/apps/web')).toBe('https://argocd.example.com/apps/web');
    expect(safeHref('grafana.example.com/d/abc', 'app.kubernetes.io/dashboard')).toBe('https://grafana.example.com/d/abc');
    expect(safeHref('grafana.example.com', 'argocd.argoproj.io/url')).toBe('https://grafana.example.com/');
    expect(safeHref('grafana.example.com', 'app')).toBeUndefined();
    expect(safeHref('ftp://files', 'homepage')).toBeUndefined();
    expect(safeHref('not a url', 'runbook_url')).toBeUndefined();
  });

  it('matches every word of a mini filter across the row fields', () => {
    expect(matchesMiniFilter('', ['a'])).toBe(true);
    expect(matchesMiniFilter('web prod', ['Deployment', 'web', 'prod'])).toBe(true);
    expect(matchesMiniFilter('web stage', ['Deployment', 'web', 'prod'])).toBe(false);
  });
});

describe('signals and tab attention', () => {
  it('looks signals up by context and kind|namespace|name', () => {
    const lookup = makeSignalsLookup(new Map([['kind-a', { windowMs: 1, objects: { 'Pod|apps|web-1': { warnings: [{ reason: 'BackOff', message: 'x', count: 2 }] } } }]]));
    expect(lookup?.('kind-a', 'Pod', 'apps', 'web-1')?.warnings[0]?.reason).toBe('BackOff');
    expect(lookup?.('kind-a', 'Pod', 'apps', 'web-2')).toBeUndefined();
    expect(makeSignalsLookup(undefined)).toBeUndefined();

    // Warnings recorded against an earlier object of the same name do not follow its replacement.
    const recreated = makeSignalsLookup(
      new Map([['kind-a', { windowMs: 1, objects: { 'Pod|apps|db-0': { warnings: [{ reason: 'BackOff', message: 'old', count: 1, uid: 'old' }, { reason: 'Unhealthy', message: 'untagged', count: 1 }] } } }]]),
    );
    expect(recreated?.('kind-a', 'Pod', 'apps', 'db-0', 'new')?.warnings.map((w) => w.reason)).toEqual(['Unhealthy']);
    expect(recreated?.('kind-a', 'Pod', 'apps', 'db-0', 'old')?.warnings.map((w) => w.reason)).toEqual(['BackOff', 'Unhealthy']);
    expect(recreated?.('kind-a', 'Pod', 'apps', 'db-0')?.warnings).toHaveLength(2);
    const onlyOld = makeSignalsLookup(new Map([['kind-a', { windowMs: 1, objects: { 'Pod|apps|db-0': { warnings: [{ reason: 'BackOff', message: 'old', count: 1, uid: 'old' }] } } }]]));
    expect(onlyOld?.('kind-a', 'Pod', 'apps', 'db-0', 'new')).toBeUndefined();
  });

  it('parses the object a page tab shows', () => {
    expect(tabSelection('/r/core/v1/pods?sel=kind-a%7Capps%7Cweb-1&dt=events')).toEqual({ ctx: 'kind-a', group: '', version: 'v1', plural: 'pods', kind: 'Pod', namespace: 'apps', name: 'web-1' });
    expect(tabSelection('/r/core/v1/nodes?sel=kind-a%7C%7Cworker-1')).toMatchObject({ kind: 'Node', namespace: undefined, name: 'worker-1' });
    expect(tabSelection('/r/core/v1/pods')).toBeUndefined();
    expect(tabSelection('/helm')).toBeUndefined();
    expect(tabSelection('/r/acme.io/v1/widgets?sel=kind-a%7Capps%7Cw', [{ group: 'acme.io', version: 'v1', plural: 'widgets', kind: 'Widget', namespaced: true, verbs: [] }])).toMatchObject({ kind: 'Widget' });
    expect(tabSelection('/r/acme.io/v1/widgets?sel=kind-a%7Capps%7Cw')).toBeUndefined();
  });

  it('marks and clears tab attention', () => {
    useTabAttentionStore.getState().mark('t1', 'went bad');
    useTabAttentionStore.getState().mark('t1', 'went bad');
    expect(useTabAttentionStore.getState().attention).toEqual({ t1: { reason: 'went bad' } });
    useTabAttentionStore.getState().clear('t1');
    useTabAttentionStore.getState().clear('t1');
    expect(useTabAttentionStore.getState().attention).toEqual({});
  });
});

describe('per-cluster namespaces', () => {
  it('remembers a selection per cluster and shows the union of the selected ones', () => {
    const store = useClustersStore.getState();
    store.setSelected(['dev']);
    store.setNamespaces(['team-a']);
    expect(useClustersStore.getState().namespaces).toEqual(['team-a']);

    store.setSelected(['prod']);
    expect(useClustersStore.getState().namespaces).toEqual([]);
    useClustersStore.getState().setNamespaces(['payments']);

    useClustersStore.getState().setSelected(['dev', 'prod']);
    expect(useClustersStore.getState().namespaces).toEqual(['team-a', 'payments']);
    // Editing the union applies to every selected cluster; clearing forgets both.
    useClustersStore.getState().setNamespaces(['shared']);
    expect(useClustersStore.getState().namespacesByContext).toEqual({ dev: ['shared'], prod: ['shared'] });
    useClustersStore.getState().setNamespaces([]);
    expect(useClustersStore.getState().namespacesByContext).toEqual({});

    useClustersStore.getState().setNamespaces(['only-dev'], ['dev']);
    useClustersStore.getState().toggleContext('prod');
    expect(useClustersStore.getState().namespaces).toEqual(['only-dev']);
    useClustersStore.getState().removeContext('dev');
    expect(useClustersStore.getState().namespaces).toEqual([]);
    expect(namespacesForContexts({ a: ['x', 'y'], b: ['y', 'z'] }, ['b', 'a'])).toEqual(['y', 'z', 'x']);
  });

  it('remembers list filters and scroll per kind and forgets cleared ones', () => {
    const prefs = useUiPrefsStore.getState();
    prefs.setListState('/r/core/v1/pods', { q: '/status:crash', scrollTop: 120 });
    expect(useUiPrefsStore.getState().listState['/r/core/v1/pods']).toEqual({ q: '/status:crash', scrollTop: 120 });
    prefs.setListState('/r/core/v1/pods', { q: '' });
    expect(useUiPrefsStore.getState().listState['/r/core/v1/pods']).toEqual({ scrollTop: 120 });
    prefs.setListState('/r/core/v1/pods', { scrollTop: undefined });
    expect(useUiPrefsStore.getState().listState['/r/core/v1/pods']).toBeUndefined();
  });
});

