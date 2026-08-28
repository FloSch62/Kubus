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
  uninstall: {
    isPending: false,
    mutate: vi.fn(),
  },
  refetchUpdates: vi.fn(),
}));

const effects = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useAppInfo: () => ({ data: { helmEngine: true } }),
  useHelmOperations: () => ({ data: fixtures.operations, error: null, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useHelmReleases: () => ({ data: fixtures.releases, isLoading: false }),
  useHelmUninstall: () => fixtures.uninstall,
  useHelmUpdates: () => ({ data: [], isFetching: false, refetch: fixtures.refetchUpdates }),
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
  return <output data-testid="location">{location.pathname}</output>;
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

  it('keeps protected-cluster confirmation and blocks uninstall during an active operation', () => {
    useClustersStore.setState({ contextSettings: { dev: { protected: true } } });
    const view = renderPage();

    fireEvent.contextMenu(releaseRow(), { clientX: 24, clientY: 36 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Uninstall…' }));
    const confirm = screen.getByRole('button', { name: 'Uninstall' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('web'), { target: { value: 'web' } });
    expect(confirm).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fixtures.operations = [operation('running')];
    view.rerender(
      <MemoryRouter initialEntries={['/helm']}>
        <Routes>
          <Route path="*" element={<HelmPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.contextMenu(releaseRow(), { clientX: 24, clientY: 36 });
    expect(screen.getByRole('menuitem', { name: 'Uninstall…' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('opens the context menu from Shift+F10', () => {
    renderPage();

    const cell = screen.getByText('web').closest('.MuiDataGrid-cell')!;
    fireEvent.keyDown(cell, { key: 'F10', shiftKey: true });

    expect(screen.getByRole('menuitem', { name: 'Open release' })).toBeInTheDocument();
  });
});
