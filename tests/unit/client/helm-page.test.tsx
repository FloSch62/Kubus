import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelmOperation, HelmReleaseSummary } from '@kubus/shared';
import { HelmPage } from '../../../client/src/pages/HelmPage';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

interface ReleaseRow {
  ctx: string;
  release: HelmReleaseSummary;
}

const fixtures = vi.hoisted(() => ({
  releases: [] as ReleaseRow[],
  operations: [] as HelmOperation[],
  errors: {} as Record<string, Error>,
  updates: [] as Array<{ id: string; chart: string; currentVersion: string; available: boolean; latestVersion?: string; reason?: string }>,
  watchStatus: {} as Record<string, { state: string; message?: string }>,
  uninstall: {
    isPending: false,
    mutate: vi.fn(),
  },
  refetchUpdates: vi.fn(),
  refetchReleases: vi.fn(),
}));

const effects = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useAppInfo: () => ({ data: { helmEngine: true } }),
  useHelmOperations: () => ({ data: fixtures.operations, error: null, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useHelmReleases: () => ({ rows: fixtures.releases, errors: fixtures.errors, isLoading: false, isFetching: false, dataUpdatedAt: 0, refetch: fixtures.refetchReleases }),
  useHelmUninstall: () => fixtures.uninstall,
  useHelmUpdates: () => ({ data: fixtures.updates, isFetching: false, refetch: fixtures.refetchUpdates }),
  useHelmWatchStatus: () => ({ data: fixtures.watchStatus }),
  helmWatchLive: (status: Record<string, { state: string }> | undefined, contexts: string[]) =>
    contexts.length > 0 && contexts.every((ctx) => status?.[ctx]?.state === 'live'),
}));

vi.mock('../../../client/src/components/CellCopy.js', () => ({
  CellCopyOverlay: () => null,
  copyCellGridSx: {},
  handleCopyCellKeyDown: vi.fn(),
  withCellCopy: (column: unknown) => column,
}));
vi.mock('../../../client/src/components/HelmOperationsOverview.js', () => ({ HelmOperationsOverview: () => null }));
vi.mock('../../../client/src/components/grid-prefs.js', () => ({
  useGridPrefs: (_id: string, columns: unknown[]) => ({ columns, density: 'compact', onColumnWidthChange: vi.fn() }),
}));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));

function release(name = 'web'): ReleaseRow {
  return {
    ctx: 'dev',
    release: {
      name,
      namespace: 'team-a',
      revision: 3,
      status: 'deployed',
      chart: 'nginx',
      chartVersion: '1.2.3',
      appVersion: '1.25.0',
    },
  };
}

function operation(status: HelmOperation['status']): HelmOperation {
  return {
    id: 'op-1',
    kind: 'upgrade',
    ctx: 'dev',
    namespace: 'team-a',
    releaseName: 'web',
    status,
    phase: 'applying',
    message: 'Applying resources',
    startedAt: '2026-08-28T10:00:00Z',
    updatedAt: '2026-08-28T10:00:01Z',
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/helm']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <HelmPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function releaseRow() {
  return screen.getByText('web').closest('.MuiDataGrid-row')!;
}

beforeEach(() => {
  fixtures.releases = [release()];
  fixtures.operations = [];
  fixtures.errors = {};
  fixtures.updates = [];
  fixtures.watchStatus = { dev: { state: 'live' } };
  fixtures.refetchReleases.mockReset();
  fixtures.uninstall.isPending = false;
  fixtures.uninstall.mutate.mockReset();
  fixtures.uninstall.mutate.mockImplementation((_variables, options) =>
    options.onSuccess({ deleted: ['Deployment/team-a/web'], failed: [], hooksRan: [], crdsDeleted: [], recordsRetained: false }),
  );
  fixtures.refetchUpdates.mockReset();
  effects.toast.mockReset();
  useClustersStore.setState({ selected: ['dev'], namespaces: [], contextSettings: {} });
  useUiPrefsStore.setState({ protectByDefault: false });
});

describe('HelmPage release context menu', () => {
  it('opens release details from a right-click menu', () => {
    renderPage();

    fireEvent.contextMenu(releaseRow(), { clientX: 24, clientY: 36 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open release' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/helm/dev/team-a/web');
  });

  it('confirms and uninstalls the selected release', async () => {
    renderPage();

    fireEvent.contextMenu(releaseRow(), { clientX: 24, clientY: 36 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Uninstall…' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Uninstall team-a/web from cluster dev');
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));

    expect(fixtures.uninstall.mutate).toHaveBeenCalledWith(
      { ctx: 'dev', ns: 'team-a', name: 'web' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(effects.toast).toHaveBeenCalledWith('success', 'Uninstalled web: 1 resources deleted');
  });

  it('disables an open confirmation when an operation starts in another window', () => {
    useClustersStore.setState({ contextSettings: { dev: { protected: true } } });
    const view = renderPage();

    fireEvent.contextMenu(releaseRow(), { clientX: 24, clientY: 36 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Uninstall…' }));
    const confirm = screen.getByRole('button', { name: 'Uninstall' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('web'), { target: { value: 'web' } });
    expect(confirm).toBeEnabled();

    fixtures.operations = [operation('running')];
    view.rerender(
      <MemoryRouter initialEntries={['/helm']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <HelmPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(confirm).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot uninstall while the upgrade operation is running.');
    fireEvent.click(confirm);
    expect(fixtures.uninstall.mutate).not.toHaveBeenCalled();
  });

  it('opens the context menu from Shift+F10', () => {
    renderPage();

    const cell = screen.getByText('web').closest('.MuiDataGrid-cell')!;
    fireEvent.keyDown(cell, { key: 'F10', shiftKey: true });

    expect(screen.getByRole('menuitem', { name: 'Open release' })).toBeInTheDocument();
  });

  it('hands an upgrade request to the release page', () => {
    renderPage();

    fireEvent.contextMenu(releaseRow(), { clientX: 24, clientY: 36 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Upgrade…' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/helm/dev/team-a/web?action=upgrade');
  });
});

describe('HelmPage live list', () => {
  it('shows the live signal per cluster, surfaces cluster errors and filters releases', async () => {
    const failed = release('db');
    failed.release.status = 'failed';
    fixtures.releases = [release(), failed];
    fixtures.errors = { prod: new Error('connection refused') };
    fixtures.watchStatus = { dev: { state: 'live' }, prod: { state: 'unavailable', message: 'secrets is forbidden' } };
    useClustersStore.setState({ selected: ['dev', 'prod'], namespaces: [], contextSettings: {} });
    renderPage();

    expect(screen.getByLabelText('Helm updates: Live 1/2')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Releases could not be loaded from prod: connection refused');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fixtures.refetchReleases).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh releases' }));
    expect(fixtures.refetchReleases).toHaveBeenCalledTimes(2);

    expect(screen.getByRole('button', { name: /Needs attention · 1/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Needs attention/ }));
    expect(screen.queryByText('web')).not.toBeInTheDocument();
    expect(screen.getByText('db')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(screen.getByText('web')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Filter releases/), { target: { value: 'WEB' } });
    await waitFor(() => expect(screen.queryByText('db')).not.toBeInTheDocument());
    expect(screen.getByText('web')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Filter releases/), { target: { value: 'nothing-here' } });
    await waitFor(() => expect(screen.getByText('No matches, 2 releases hidden by the current filters')).toBeInTheDocument());
  });

  it('offers an install when the selected clusters have no releases', () => {
    fixtures.releases = [];
    renderPage();

    expect(screen.getByText('No Helm releases in the selected clusters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install a chart' })).toBeInTheDocument();
    expect(screen.getByLabelText('Helm updates: Live')).toBeInTheDocument();
  });
});
