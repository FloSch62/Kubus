import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceRef, SearchResult } from '@kubus/shared';

// The client project swaps @tanstack/react-query for a harness that answers
// queries from this map, keyed by the serialized query key.
const harness = vi.hoisted(() => {
  const value = {
    queryConfigs: [] as unknown[],
    mutationConfigs: [] as unknown[],
    multiQueryConfigs: [] as unknown[],
    queryResults: new Map<string, { data?: unknown; error?: unknown }>(),
    queryClient: {},
  };
  Reflect.set(globalThis, Symbol.for('kubus.test.query-harness'), value);
  return value;
});
import { SearchDialog } from '../../../client/src/layout/SearchDialog';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useNavigationStore } from '../../../client/src/state/navigation';
import { useRecentStore } from '../../../client/src/state/recent';

const fixtures = vi.hoisted(() => ({
  results: [] as SearchResult[],
  namespaces: ['chaos', 'demo', 'kube-system'],
  connect: vi.fn(),
  runAction: vi.fn(),
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useGlobalSearch: (_contexts: string[], query: string) => ({ data: query.trim().length > 1 ? fixtures.results : undefined, isFetching: false }),
  useApiResourcesForContexts: () => ({ data: undefined }),
  useContexts: () => ({
    data: [
      { name: 'kind-a', cluster: 'a', user: 'a', health: 'connected', active: true, kubernetesVersion: 'v1.36.1' },
      { name: 'kind-b', cluster: 'b', user: 'b', health: 'connected', active: false, kubernetesVersion: 'v1.36.1' },
    ],
  }),
  useNamespaces: (contexts: string[]) => ({ data: contexts.length ? fixtures.namespaces : undefined }),
  useConnectContext: () => ({ mutate: fixtures.connect }),
  resourceUrl: (ctx: string, _g: string, _v: string, plural: string, name: string) => `/api/${ctx}/${plural}/${name}`,
}));

vi.mock('../../../client/src/actions/resource-actions.js', () => ({
  actionsForRef: () => [
    { id: 'open', title: 'Open details', kind: 'detail' },
    { id: 'logs', title: 'Logs', kind: 'run', rowKey: 'logs' },
  ],
  usePaletteRunner: () => fixtures.runAction,
}));

function ref(kind: string, plural: string, group: string, name: string): ResourceRef {
  return { ctx: 'kind-a', group, version: 'v1', plural, kind, name, namespace: 'demo' };
}

function result(r: ResourceRef, score: number): SearchResult {
  return { id: `resource:${r.ctx}:${r.group}/${r.version}/${r.plural}:${r.namespace}:${r.name}`, kind: 'resource', title: `${r.kind}/${r.name}`, score, ref: r };
}

function renderDialog() {
  return render(
    <MemoryRouter>
      <SearchDialog open onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

/** The status lookup the palette makes for a result, answered with `obj`. */
function answerStatus(r: ResourceRef, obj: unknown) {
  const sel = { ctx: r.ctx, group: r.group, version: r.version, plural: r.plural, name: r.name, namespace: r.namespace };
  harness.queryResults.set(JSON.stringify(['resource', sel]), { data: obj });
}

beforeEach(() => {
  harness.queryResults.clear();
  fixtures.results = [];
  fixtures.connect.mockClear();
  useClustersStore.setState({ selected: ['kind-a'], namespaces: [], namespacesByContext: {} });
  useNavigationStore.setState({ favorites: [] });
  useRecentStore.setState({ recent: [] });
});

describe('SearchDialog', () => {
  it('opens on recent resources, destinations and actions instead of "No matches."', () => {
    useRecentStore.getState().record(ref('Pod', 'pods', '', 'crashloop'));
    renderDialog();

    expect(screen.queryByText('No matches.')).not.toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('crashloop')).toBeInTheDocument();
    expect(screen.getByText('Go to')).toBeInTheDocument();
    expect(screen.getByText('Deployments')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('Switch cluster…')).toBeInTheDocument();
  });

  it('only lists recents from connected clusters', () => {
    useRecentStore.getState().record({ ...ref('Pod', 'pods', '', 'elsewhere'), ctx: 'kind-b' });
    renderDialog();
    expect(screen.queryByText('elsewhere')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
  });

  it('groups results by category and collapses sibling pods', async () => {
    const deployment = ref('Deployment', 'deployments', 'apps', 'podinfo');
    answerStatus(deployment, {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'podinfo', generation: 1 },
      spec: { replicas: 3 },
      status: { observedGeneration: 1, replicas: 3, readyReplicas: 3, updatedReplicas: 3 },
    });
    fixtures.results = [
      result(deployment, 120),
      result(ref('Pod', 'pods', '', 'podinfo-5c7cd-aaaaa'), 60),
      result(ref('Pod', 'pods', '', 'podinfo-5c7cd-bbbbb'), 60),
      result(ref('Pod', 'pods', '', 'podinfo-5c7cd-ccccc'), 60),
      result(ref('Service', 'services', '', 'podinfo'), 90),
    ];
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/Search resources, pages, kinds/), { target: { value: 'podinfo' } });

    expect(await screen.findByText('Workloads')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('5 results')).toBeInTheDocument();
    expect(screen.getByText(/3 Pods · demo/)).toBeInTheDocument();
    // Names render with the match highlighted, so the unmatched tail is its own text node.
    expect(screen.queryByText('-5c7cd-aaaaa')).not.toBeInTheDocument();

    // Status lookups fill in the ready count of the deployment.
    expect(await screen.findByText('3/3')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/3 Pods · demo/));
    expect(await screen.findByText('-5c7cd-aaaaa')).toBeInTheDocument();
    expect(screen.getByText('-5c7cd-ccccc')).toBeInTheDocument();
  });

  it('counts every member of a folded pod group, not just the first few', async () => {
    const pods = Array.from({ length: 12 }, (_, i) => ref('Pod', 'pods', '', `web-5c7cd-${String(i).padStart(5, 'x')}`));
    pods.forEach((pod, i) =>
      answerStatus(pod, { apiVersion: 'v1', kind: 'Pod', metadata: { name: pod.name }, status: { phase: i < 10 ? 'Running' : 'Pending' } }),
    );
    fixtures.results = pods.map((pod) => result(pod, 60));
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/Search resources, pages, kinds/), { target: { value: 'web' } });

    expect(await screen.findByText(/12 Pods · demo/)).toBeInTheDocument();
    expect(await screen.findByText('2 Pending · 10 Running')).toBeInTheDocument();
  });

  it('says how many members were checked when only some statuses are known', async () => {
    const pods = Array.from({ length: 4 }, (_, i) => ref('Pod', 'pods', '', `api-5c7cd-${String(i).padStart(5, 'y')}`));
    answerStatus(pods[0]!, { apiVersion: 'v1', kind: 'Pod', metadata: { name: pods[0]!.name }, status: { phase: 'Running' } });
    fixtures.results = pods.map((pod) => result(pod, 60));
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/Search resources, pages, kinds/), { target: { value: 'api' } });

    expect(await screen.findByText('1 Running · 1 of 4 checked')).toBeInTheDocument();
  });

  it('switches namespaces from the palette', async () => {
    renderDialog();
    fireEvent.click(screen.getByText('Change namespace…'));
    const list = await screen.findByRole('list');
    expect(within(list).getByText('All namespaces')).toBeInTheDocument();
    fireEvent.click(within(list).getByText('demo'));
    await waitFor(() => expect(useClustersStore.getState().namespaces).toEqual(['demo']));
  });

  it('keeps focus in the search field when a row is pressed', () => {
    renderDialog();
    const input = screen.getByPlaceholderText(/Search resources, pages, kinds/);
    input.focus();
    const row = screen.getByText('Switch cluster…').closest('[data-idx]')!;
    const allowed = fireEvent.mouseDown(row);
    expect(allowed).toBe(false);
  });
});
