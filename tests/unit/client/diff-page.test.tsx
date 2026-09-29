import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject, ResourceKindInfo } from '@kubus/shared';

// The client project swaps @tanstack/react-query for a harness that answers
// useQuery from this map, keyed by the serialized query key.
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

const fixtures = vi.hoisted(() => ({ viewer: vi.fn() }));

import { DiffPage } from '../../../client/src/pages/DiffPage';
import { useClustersStore } from '../../../client/src/state/clusters';

const kinds: ResourceKindInfo[] = [
  { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['get', 'list'] },
  { group: '', version: 'v1', plural: 'configmaps', kind: 'ConfigMap', namespaced: true, verbs: ['get', 'list'] },
];

vi.mock('../../../client/src/api/queries.js', () => ({
  isResourceGone: (error: unknown) => (error as { status?: number } | null)?.status === 404,
  resourceUrl: (ctx: string, _group: string, _version: string, plural: string, name: string, namespace?: string) => `obj:${ctx}/${plural}/${namespace ?? ''}/${name}`,
  useApiResources: () => ({ data: kinds }),
  useContexts: () => ({
    data: [
      { name: 'kind-a', active: true },
      { name: 'kind-b', active: true },
    ],
  }),
  useNamespaces: () => ({ data: ['shop'] }),
}));
vi.mock('../../../client/src/api/http.js', () => ({ apiFetch: vi.fn() }));
vi.mock('../../../client/src/components/DiffViewer.js', () => ({
  DiffViewer: (props: { left: string; right: string; hideUnchanged?: boolean }) => {
    fixtures.viewer(props);
    return <output data-testid="diff">{`${props.hideUnchanged ? 'changes-only' : 'full'}\n${props.left}\n---\n${props.right}`}</output>;
  },
}));

function deployment(replicas: number): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: 'shop', uid: `u-${replicas}`, resourceVersion: String(replicas) },
    spec: { replicas },
    status: { readyReplicas: replicas },
  } as KubeObject;
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{decodeURIComponent(location.search)}</output>;
}

function renderAt(search: string) {
  return render(
    <>
      <MemoryRouter initialEntries={[`/diff${search}`]}>
        <Routes>
          <Route
            path="/diff"
            element={
              <>
                <DiffPage />
                <Location />
              </>
            }
          />
          <Route path="/r/:group/:version/:plural" element={<Location />} />
        </Routes>
      </MemoryRouter>
    </>,
  );
}

function setObject(ctx: string, result: { data?: KubeObject; error?: unknown }) {
  harness.queryResults.set(JSON.stringify(['diff-object', ctx, 'apps', 'v1', 'deployments', 'shop', 'web']), result);
  harness.queryResults.set(JSON.stringify(['diff-names', ctx, 'apps', 'v1', 'deployments', 'shop']), { data: { names: result.data ? ['api', 'web'] : ['api'] } });
}

/** Whether the name-list query for a cluster's side was ever allowed to run. */
function namesRequested(ctx: string): boolean {
  return (harness.queryConfigs as Array<{ queryKey: unknown[]; enabled?: boolean }>).some((c) => c.queryKey[0] === 'diff-names' && c.queryKey[1] === ctx && c.enabled);
}

const left = 'kind-a|apps/v1/deployments|shop|web';
const right = 'kind-b|apps/v1/deployments|shop|web';

beforeEach(() => {
  fixtures.viewer.mockClear();
  harness.queryResults.clear();
  harness.queryConfigs.length = 0;
  setObject('kind-a', { data: deployment(1) });
  setObject('kind-b', { data: deployment(2) });
  useClustersStore.setState({ selected: ['kind-a'], namespaces: [], namespacesByContext: {} });
});

describe('DiffPage', () => {
  it('restores a compare from the URL, titles linking back to each side', async () => {
    renderAt(`?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
    await waitFor(() => expect(screen.getByTestId('diff').textContent).toContain('replicas: 2'));
    expect(screen.getByTestId('diff').textContent).toContain('replicas: 1');
    // Normalized by default: no status, no server-set metadata.
    expect(screen.getByTestId('diff').textContent).not.toContain('readyReplicas');
    expect(screen.getByTestId('diff').textContent).not.toContain('resourceVersion');

    fireEvent.click(screen.getByRole('button', { name: 'kind-b · Deployment shop/web' }));
    expect(screen.getByTestId('location').textContent).toBe('?sel=kind-b|shop|web');
  });

  it('keeps only changes and the spec scope in the URL', async () => {
    renderAt(`?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
    await waitFor(() => expect(screen.getByTestId('diff')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('switch', { name: 'Only changes' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('changes=only'));
    expect(screen.getByTestId('diff').textContent).toMatch(/^changes-only/);

    fireEvent.click(screen.getByRole('button', { name: 'Spec/data only' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('scope=spec'));
    expect(screen.getByTestId('diff').textContent).not.toContain('metadata');
    expect(screen.getByTestId('diff').textContent).toContain('spec:');
    expect(screen.getByRole('switch', { name: 'Ignore status & server-set metadata' })).toBeDisabled();
  });

  it('proposes the same object in another cluster when only the left side is given', async () => {
    renderAt(`?left=${encodeURIComponent(left)}`);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain(`right=${right}`));
    await waitFor(() => expect(screen.getByTestId('diff')).toBeInTheDocument());
  });

  it('explains a missing right side and hands over its name picker', async () => {
    setObject('kind-b', { error: Object.assign(new Error('not found'), { status: 404 }) });
    renderAt(`?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
    expect(await screen.findByText('kind-b · Deployment shop/web does not exist. Pick another object on the right.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('combobox', { name: 'Name' })[1]));
    // The picker opened, so its names were fetched; the missing name is
    // flagged from the object's own 404, not from the list.
    await waitFor(() => expect(namesRequested('kind-b')).toBe(true));
    expect(namesRequested('kind-a')).toBe(false);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'api' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'web not found here' })).toBeInTheDocument();
  });

  it('lists no names until a picker is opened', async () => {
    renderAt(`?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
    await waitFor(() => expect(screen.getByTestId('diff')).toBeInTheDocument());
    expect(harness.queryConfigs.some((c) => (c as { queryKey: unknown[] }).queryKey[0] === 'diff-names')).toBe(true);
    expect(namesRequested('kind-a')).toBe(false);
    expect(namesRequested('kind-b')).toBe(false);

    fireEvent.mouseDown(screen.getAllByRole('combobox', { name: 'Name' })[0]!);
    await waitFor(() => expect(namesRequested('kind-a')).toBe(true));
    expect(namesRequested('kind-b')).toBe(false);
    expect(within(await screen.findByRole('listbox')).queryByText('not found here')).not.toBeInTheDocument();
  });

  it('picks a kind on both sides unless the kinds are kept separate', async () => {
    renderAt(`?left=${encodeURIComponent(left)}&right=${encodeURIComponent('kind-b|core/v1/configmaps|staging|')}&kinds=separate`);
    const sync = await screen.findByRole('switch', { name: 'Same kind on both sides' });
    expect(sync).not.toBeChecked();

    // Turning it on lines the right side up with the left, in its own namespace.
    fireEvent.click(sync);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`?left=${left}&right=kind-b|apps/v1/deployments|staging|`));

    // Now a kind picked on the left is picked on the right too.
    fireEvent.mouseDown(screen.getAllByRole('combobox', { name: 'Kind' })[0]!);
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'ConfigMap' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('?left=kind-a|core/v1/configmaps|shop|&right=kind-b|core/v1/configmaps|staging|'));
  });

  it('swaps the two sides', async () => {
    renderAt(`?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
    await waitFor(() => expect(screen.getByTestId('diff')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Swap sides' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`?left=${right}&right=${left}`));
  });
});
