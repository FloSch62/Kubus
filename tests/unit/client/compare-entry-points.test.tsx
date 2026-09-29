import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject, ResourceKindInfo } from '@kubus/shared';
import { RowActionMenu } from '../../../client/src/components/RowActions';
import { ResourceListPage } from '../../../client/src/pages/ResourceListPage';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useTabsStore } from '../../../client/src/state/tabs';

interface Row {
  ctx: string;
  obj: KubeObject;
}

const fixtures = vi.hoisted(() => ({
  rows: [] as Row[],
  navigate: vi.fn(),
}));

const mutation = { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})) };
const deployments: ResourceKindInfo = { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['get', 'list'] };

vi.mock('../../../client/src/api/queries.js', () => ({
  resolveLogTargetPods: vi.fn(),
  useCordon: () => mutation,
  useDebugImages: () => ({ data: [] }),
  useDebugPod: () => mutation,
  useDeleteResource: () => mutation,
  useDrain: () => mutation,
  useRerunJob: () => mutation,
  useKubeconfigSettings: () => ({ data: undefined, isLoading: false }),
  useResourceList: () => ({ data: undefined, isLoading: false }),
  useRolloutPause: () => mutation,
  useRolloutRestart: () => mutation,
  useScale: () => mutation,
  useSetImage: () => mutation,
  useSuspendCronJob: () => mutation,
  useClusterSignals: () => ({ data: undefined }),
  useApiResourcesForContexts: () => ({ data: { resources: [deployments], byContext: { 'kind-a': [deployments], 'kind-b': [deployments] }, errors: {} } }),
  useFilteredList: () => ({ rows: fixtures.rows, status: {} }),
  useResourceMetrics: () => ({ data: undefined }),
  useWatchedList: () => ({ rows: [], status: {} }),
  useCrdColumns: () => ({ data: undefined }),
  useCreateResource: () => mutation,
  useDryRunResource: () => mutation,
}));
vi.mock('../../../client/src/app-navigate.js', () => ({ appNavigate: fixtures.navigate }));
vi.mock('../../../client/src/components/ResourceTable.js', () => ({
  ResourceTable: (props: { rows: Row[]; toolbar?: ReactNode; selectionBar?: ReactNode; onSelectionChange?: (rows: Row[]) => void }) => (
    <section>
      <div>{props.toolbar}</div>
      <div>{props.selectionBar}</div>
      <button onClick={() => props.onSelectionChange?.(props.rows.slice(0, 1))}>Mock select one</button>
      <button onClick={() => props.onSelectionChange?.(props.rows.slice(0, 2))}>Mock select two</button>
      <button onClick={() => props.onSelectionChange?.(props.rows)}>Mock select all</button>
    </section>
  ),
}));
vi.mock('../../../client/src/components/ResourceDetailDrawer.js', () => ({ ResourceDetailPanel: () => null }));
vi.mock('../../../client/src/components/ApiResourceDrawer.js', () => ({ ApiResourceDrawer: () => null }));

function deployment(ctx: string, name: string): Row {
  return { ctx, obj: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: 'shop', uid: `${ctx}-${name}` }, spec: {}, status: {} } };
}

beforeEach(() => {
  fixtures.navigate.mockClear();
  fixtures.rows = [deployment('kind-a', 'web'), deployment('kind-b', 'web'), deployment('kind-a', 'api')];
  useClustersStore.setState({ selected: ['kind-a', 'kind-b'], namespaces: [], namespacesByContext: {}, contextSettings: {} });
  useTabsStore.setState({ tabs: [{ id: 'list', path: '/r/apps/v1/deployments' }], activeId: 'list', closedPaths: [] });
});

describe('starting a compare', () => {
  it('Compare with… opens a diff tab with the row on the left', () => {
    render(
      <MemoryRouter>
        <RowActionMenu
          target={{ ctx: 'kind-a', group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', obj: fixtures.rows[0]!.obj }}
          anchorPosition={{ top: 10, left: 10 }}
          open
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compare with…' }));
    const path = `/diff?left=${encodeURIComponent('kind-a|apps/v1/deployments|shop|web')}`;
    expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(['/r/apps/v1/deployments', path]);
    expect(fixtures.navigate).toHaveBeenCalledWith(path);
  });

  it('Compare 2 appears for exactly two checked rows and fills both sides', () => {
    render(
      <MemoryRouter initialEntries={['/r/apps/v1/deployments']}>
        <Routes>
          <Route path="/r/:group/:version/:plural" element={<ResourceListPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Compare 2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mock select one' }));
    expect(screen.queryByRole('button', { name: 'Compare 2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mock select all' }));
    expect(screen.queryByRole('button', { name: 'Compare 2' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mock select two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare 2' }));
    const left = encodeURIComponent('kind-a|apps/v1/deployments|shop|web');
    const right = encodeURIComponent('kind-b|apps/v1/deployments|shop|web');
    expect(fixtures.navigate).toHaveBeenCalledWith(`/diff?left=${left}&right=${right}`);
    expect(useTabsStore.getState().tabs.at(-1)?.path).toBe(`/diff?left=${left}&right=${right}`);
  });
});
