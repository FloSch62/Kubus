import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject, PrinterColumn, ResourceKindInfo } from '@kubus/shared';
import { ResourceListPage } from '../../../client/src/pages/ResourceListPage';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useDetailStore } from '../../../client/src/state/detail';
import { useDockStore } from '../../../client/src/state/dock';
import { useNavigationStore } from '../../../client/src/state/navigation';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

interface Row {
  ctx: string;
  obj: KubeObject;
}

const fixtures = vi.hoisted(() => ({
  resources: [] as ResourceKindInfo[],
  byContext: {} as Record<string, ResourceKindInfo[]>,
  discoveryErrors: {} as Record<string, string>,
  rows: [] as Row[],
  status: {} as Record<string, { state: string; message?: string }>,
  auxRows: [] as Row[],
  metrics: undefined as Map<string, { available: boolean; items: unknown[] }> | undefined,
  printerColumns: undefined as PrinterColumn[] | undefined,
  deleteFailures: new Set<string>(),
  restartFailures: new Set<string>(),
  create: { mutateAsync: vi.fn(async () => ({})) },
  dryRun: { mutateAsync: vi.fn(async () => ({ ok: true, findings: [] })) },
  del: { mutateAsync: vi.fn(async (value: { name: string }) => {
    if (fixtures.deleteFailures.has(value.name)) throw new Error(`cannot delete ${value.name}`);
    return {};
  }) },
  restart: { mutateAsync: vi.fn(async (value: { body: { name: string } }) => {
    if (fixtures.restartFailures.has(value.body.name)) throw 'restart rejected';
    return {};
  }) },
}));

const effects = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useApiResourcesForContexts: () => ({ data: { resources: fixtures.resources, byContext: fixtures.byContext, errors: fixtures.discoveryErrors } }),
  useFilteredList: () => ({ rows: fixtures.rows, status: fixtures.status }),
  useResourceMetrics: () => ({ data: fixtures.metrics }),
  useWatchedList: () => ({ rows: fixtures.auxRows, status: {} }),
  useCrdColumns: () => ({ data: fixtures.printerColumns }),
  useCreateResource: () => fixtures.create,
  useDryRunResource: () => fixtures.dryRun,
  useDeleteResource: () => fixtures.del,
  useRolloutRestart: () => fixtures.restart,
}));

vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
vi.mock('../../../client/src/components/RowActions.js', () => ({
  isLogTargetKind: (kind: string) => ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'Service'].includes(kind),
  RowLogsButton: ({ target }: { target: { obj: KubeObject } }) => <button>Quick logs {target.obj.metadata.name}</button>,
  RowActions: ({ target }: { target: { obj: KubeObject } }) => <button>Actions {target.obj.metadata.name}</button>,
  RowActionMenu: ({ target, open, onClose }: { target: { obj: KubeObject }; open: boolean; onClose: () => void }) =>
    open ? <button onClick={onClose}>Context actions {target.obj.metadata.name}</button> : null,
}));
vi.mock('../../../client/src/components/ResourceTable.js', () => ({
  ResourceTable: (props: {
    rows: Row[];
    columns: Array<{ field: string; valueGetter?: (...args: unknown[]) => unknown; renderCell?: (params: { row: Row; value?: unknown }) => ReactNode }>;
    toolbar?: ReactNode;
    onSelectionChange?: (rows: Row[]) => void;
    onFilterChange?: (value: string) => void;
    onLabelSelectorChange?: (value: string) => void;
    onRowClick?: (row: Row) => void;
    onRowActivate?: (row: Row) => void;
    onRowContextMenu?: (row: Row, position: { clientX: number; clientY: number }) => void;
    hiddenFields?: string[];
    activeRowId?: string;
    loading?: boolean;
  }) => (
    <section data-testid="resource-table">
      <div>{props.toolbar}</div>
      <output data-testid="table-state">{JSON.stringify({ hidden: props.hiddenFields, active: props.activeRowId, loading: props.loading })}</output>
      <button onClick={() => props.onSelectionChange?.(props.rows)}>Mock select all</button>
      <button onClick={() => props.onSelectionChange?.([])}>Mock clear selection</button>
      <button onClick={() => props.onFilterChange?.('failed pods')}>Mock text filter</button>
      <button onClick={() => props.onFilterChange?.('')}>Mock clear filter</button>
      <button onClick={() => props.onLabelSelectorChange?.('app=web')}>Mock label filter</button>
      <button onClick={() => props.onRowClick?.(props.rows[0]!)}>Mock open row</button>
      <button onClick={() => props.onRowActivate?.(props.rows[0]!)}>Mock activate row</button>
      <button onClick={() => props.onRowContextMenu?.(props.rows[0]!, { clientX: 20, clientY: 30 })}>Mock context row</button>
      {props.rows[0] && props.columns.flatMap((column) => {
        if (!column.renderCell) return [];
        const value = column.valueGetter?.(undefined, props.rows[0], column, {});
        return [<div key={column.field}>{column.renderCell({ row: props.rows[0]!, value })}</div>];
      })}
    </section>
  ),
}));
vi.mock('../../../client/src/components/ResourceDetailDrawer.js', () => ({
  ResourceDetailPanel: ({ sel, onClose, onBack }: { sel: { name: string }; onClose: () => void; onBack?: () => void }) => (
    <div>
      Detail panel {sel.name}
      <button onClick={onClose}>Close detail mock</button>
      {onBack && <button onClick={onBack}>Back detail mock</button>}
    </div>
  ),
}));
vi.mock('../../../client/src/components/ApiResourceDrawer.js', () => ({
  ApiResourceDrawer: ({ open, onClose, onOpenCrd }: { open: boolean; onClose: () => void; onOpenCrd?: () => void }) =>
    open ? (
      <div>
        API resource mock
        <button onClick={onClose}>Close API mock</button>
        {onOpenCrd && <button onClick={onOpenCrd}>Open CRD mock</button>}
      </div>
    ) : null,
}));
vi.mock('../../../client/src/components/YamlEditor.js', () => ({
  YamlEditor: ({ value, onApply, onDryRun }: { value: string; onApply?: (text: string) => Promise<void>; onDryRun?: (text: string) => Promise<unknown> }) => (
    <div>
      <output data-testid="create-template">{value}</output>
      <button onClick={() => void onDryRun?.(value)}>Dry run YAML mock</button>
      <button onClick={() => void onApply?.(value)}>Apply YAML mock</button>
    </div>
  ),
}));
vi.mock('../../../client/src/components/BatchCreateDialog.js', () => ({
  BatchCreateDialog: ({ kind, onClose }: { kind: string; onClose: () => void }) => (
    <div>
      Batch create {kind}
      <button onClick={onClose}>Close batch mock</button>
    </div>
  ),
}));

function resource(group: string, version: string, plural: string, kind: string, custom = false, namespaced = true): ResourceKindInfo {
  return { group, version, plural, kind, custom, namespaced, verbs: ['get', 'list', 'create', 'delete'] };
}

function row(name: string, ctx = 'dev', namespace = 'team-a', kind = 'Pod'): Row {
  return {
    ctx,
    obj: {
      apiVersion: kind === 'Pod' ? 'v1' : 'apps/v1',
      kind,
      metadata: { name, namespace, uid: `uid-${ctx}-${name}`, labels: { app: 'web', tier: 'frontend' } },
      spec: { containers: [{ name: 'app' }] },
      status: { phase: 'Running' },
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/r/:group/:version/:plural"
          element={
            <>
              <ResourceListPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  const pod = resource('', 'v1', 'pods', 'Pod');
  fixtures.resources = [pod];
  fixtures.byContext = { dev: [pod], prod: [pod] };
  fixtures.discoveryErrors = {};
  fixtures.rows = [row('pod-a'), row('pod-b', 'prod', 'team-b')];
  fixtures.status = { dev: { state: 'live' }, prod: { state: 'live' } };
  fixtures.auxRows = [];
  fixtures.metrics = new Map([
    ['dev', { available: true, items: [] }],
    ['prod', { available: true, items: [] }],
  ]);
  fixtures.printerColumns = undefined;
  fixtures.deleteFailures.clear();
  fixtures.restartFailures.clear();
  fixtures.create.mutateAsync.mockClear();
  fixtures.dryRun.mutateAsync.mockClear();
  fixtures.del.mutateAsync.mockClear();
  fixtures.restart.mutateAsync.mockClear();
  effects.toast.mockClear();
  useClustersStore.setState({
    selected: ['dev', 'prod'],
    namespaces: ['team-a'],
    contextSettings: { prod: { protected: true } },
  });
  useUiPrefsStore.setState({
    protectByDefault: false,
    sortModels: {},
    columnVisibility: {},
    columnWidths: {},
  });
  useNavigationStore.setState({ favorites: [], savedViews: [] });
  useDockStore.setState({ tabs: [], activeId: undefined, open: false, maximized: false });
  useDetailStore.setState({ stack: [], embedded: false, collapsed: false, width: 640, focusSeq: 0, dataDirty: false, pendingDiscard: undefined });
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) });
});

describe('ResourceListPage', () => {
  it('shows the empty cluster state', () => {
    useClustersStore.setState({ selected: [] });
    renderPage('/r/core/v1/pods');
    expect(screen.getByText('No cluster selected')).toBeInTheDocument();
    expect(screen.getByText(/Pick one or more clusters/)).toBeInTheDocument();
  });

  it('surfaces per-context health, filters, saves views, opens rows, and groups pod logs', async () => {
    const pod = fixtures.resources[0]!;
    fixtures.byContext = { dev: [pod], prod: [pod], stage: [], lab: [], loading: [pod] };
    fixtures.discoveryErrors = { ignored: 'discovery failed' };
    fixtures.status = {
      dev: { state: 'live' },
      prod: { state: 'error', message: 'watch denied' },
      stage: { state: 'reconnecting' },
      lab: { state: 'unavailable' },
      loading: { state: 'loading' },
    };
    fixtures.metrics = new Map([
      ['dev', { available: true, items: [] }],
      ['prod', { available: false, items: [] }],
    ]);
    useClustersStore.setState({ selected: ['dev', 'prod', 'stage', 'lab', 'loading', 'ignored'] });
    renderPage('/r/core/v1/pods?field=legacy&q=old&label=tier%3Dfrontend&sel=dev%7Cteam-a%7Cpod-a');

    expect(screen.getByText(/watch denied/)).toBeInTheDocument();
    expect(screen.getByText(/connection lost/)).toBeInTheDocument();
    expect(screen.getByText(/not installed on this cluster/)).toBeInTheDocument();
    expect(screen.getByText(/metrics-server is not reachable/)).toBeInTheDocument();
    expect(screen.getByTestId('table-state')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('field='));
    expect(screen.getByText('Detail panel pod-a')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(useNavigationStore.getState().savedViews[0]).toMatchObject({ textFilter: 'old', labelSelector: 'tier=frontend' });
    fireEvent.click(screen.getByRole('button', { name: 'Mock text filter' }));
    expect(screen.getByTestId('location')).toHaveTextContent('q=failed+pods');
    fireEvent.click(screen.getByRole('button', { name: 'Mock clear filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mock label filter' }));
    expect(screen.getByTestId('location')).toHaveTextContent('label=app%3Dweb');

    fireEvent.click(screen.getByRole('button', { name: 'Mock open row' }));
    expect(useDetailStore.getState().stack[0]?.name).toBe('pod-a');
    fireEvent.click(screen.getByRole('button', { name: 'Mock activate row' }));
    expect(useDetailStore.getState().focusSeq).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Mock context row' }));
    expect(screen.getByText('Context actions pod-a')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mock select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Logs (2)' }));
    expect(useDockStore.getState().tabs).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Delete (2)' }));
    fireEvent.change(screen.getByPlaceholderText('delete 2'), { target: { value: 'delete 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(effects.toast).toHaveBeenCalledWith('success', 'Deleted 2 Pods'));

    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.getByText(/Create resource on dev/)).toBeInTheDocument();
    expect(screen.getByTestId('create-template')).toHaveTextContent('kind: Pod');
    fireEvent.click(screen.getByRole('button', { name: 'Dry run YAML mock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply YAML mock' }));
    await waitFor(() => expect(fixtures.create.mutateAsync).toHaveBeenCalled());
  }, 15_000);

  it('reports partial bulk delete and restart failures', async () => {
    const deployment = resource('apps', 'v1', 'deployments', 'Deployment');
    fixtures.resources = [deployment];
    fixtures.byContext = { dev: [deployment], prod: [deployment] };
    fixtures.rows = [row('web-a', 'dev', 'team-a', 'Deployment'), row('web-b', 'prod', 'team-b', 'Deployment')];
    fixtures.deleteFailures.add('web-b');
    fixtures.restartFailures.add('web-b');
    renderPage('/r/apps/v1/deployments');

    fireEvent.click(screen.getByRole('button', { name: 'Mock select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart (2)' }));
    fireEvent.change(screen.getByPlaceholderText('restart 2'), { target: { value: 'restart 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(effects.toast).toHaveBeenCalledWith('error', expect.stringContaining('Restarted failed for 1 of 2')));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Mock select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete (2)' }));
    fireEvent.change(screen.getByPlaceholderText('delete 2'), { target: { value: 'delete 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(effects.toast).toHaveBeenCalledWith('error', expect.stringContaining('cannot delete web-b')));
  });

  it('builds custom printer columns and links the API drawer to its CRD', () => {
    const widget = resource('example.io', 'v1', 'widgets', 'Widget', true);
    fixtures.resources = [widget];
    fixtures.byContext = { dev: [widget], prod: [] };
    fixtures.rows = [row('widget-a', 'dev', 'team-a', 'Widget')];
    fixtures.printerColumns = [
      { name: 'Ready', type: 'string', jsonPath: '.status.phase' },
      { name: 'Internal', type: 'string', jsonPath: '.spec.internal', priority: 1 },
    ];
    renderPage('/r/example.io/v1/widgets');

    expect(screen.getByTestId('table-state')).toHaveTextContent('crd_1_Internal');
    fireEvent.click(screen.getByTitle('Open API resource example.io/v1/Widget'));
    expect(screen.getByText('API resource mock')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open CRD mock' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({
      kind: 'CustomResourceDefinition',
      name: 'widgets.example.io',
    });
    fireEvent.click(screen.getByLabelText('Collapse resource details'));
    fireEvent.click(screen.getByLabelText('Expand resource details'));
  });

  it('uses the guided create flow for Jobs and CronJobs', () => {
    for (const [plural, kind] of [['jobs', 'Job'], ['cronjobs', 'CronJob']] as const) {
      const info = resource('batch', 'v1', plural, kind);
      fixtures.resources = [info];
      fixtures.byContext = { dev: [info] };
      fixtures.rows = [row(`${kind.toLowerCase()}-a`, 'dev', 'team-a', kind)];
      useClustersStore.setState({ selected: ['dev'], namespaces: ['team-a'] });
      const view = renderPage(`/r/batch/v1/${plural}`);
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      expect(screen.getByText(`Batch create ${kind}`)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Close batch mock' }));
      view.unmount();
    }
  });
});
