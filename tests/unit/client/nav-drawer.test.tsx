import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavDrawer } from '../../../client/src/layout/NavDrawer';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useNavigationStore } from '../../../client/src/state/navigation';
import { useTabsStore } from '../../../client/src/state/tabs';

const queryMocks = vi.hoisted(() => ({
  resources: [] as Array<Record<string, unknown>>,
  byContext: {} as Record<string, Array<Record<string, unknown>>>,
  contexts: [] as Array<Record<string, unknown>>,
}));
const scrollIntoViewMock = vi.fn();

vi.mock('../../../client/src/api/queries.js', () => ({
  useApiResourcesForContexts: () => ({
    data: { resources: queryMocks.resources, byContext: queryMocks.byContext, errors: {} },
  }),
  useContexts: () => ({ data: queryMocks.contexts }),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

const customResources = [
  { group: 'nokia.com', version: 'v1', plural: 'fabrics', kind: 'Fabric', namespaced: false, verbs: ['get', 'list'], custom: true },
  { group: 'appstore.eda.nokia.com', version: 'v1alpha1', plural: 'widgets', kind: 'Widget', namespaced: true, verbs: ['list'], custom: true },
  { group: 'appstore.eda.nokia.com', version: 'v1beta2', plural: 'widgets', kind: 'Widget', namespaced: true, verbs: ['list'], custom: true },
  { group: 'topo.eda.nokia.com', version: 'v2alpha1', plural: 'links', kind: 'Link', namespaced: true, verbs: ['list'], custom: true },
  { group: 'other.example.net', version: 'not-semver', plural: 'gadgets', kind: 'Gadget', namespaced: true, verbs: ['list'], custom: true },
  { group: 'other.example.net', version: 'v1', plural: 'hidden', kind: 'Hidden', namespaced: true, verbs: ['get'], custom: true },
];

beforeEach(() => {
  queryMocks.resources = customResources;
  queryMocks.byContext = {};
  queryMocks.contexts = [{ name: 'dev' }, { name: 'eda' }];
  useClustersStore.setState({ selected: ['dev'], namespaces: [] });
  useNavigationStore.setState({
    favorites: [
      { id: 'kind:/v1/pods', title: 'Pods', path: '/r/core/v1/pods' },
      { id: 'category:Workloads', title: 'Workloads' },
      { id: 'legacy', title: 'Legacy', subtitle: 'old/v1', path: '/events' },
    ],
    savedViews: [
      {
        id: 'view-1',
        title: 'Failing pods',
        path: '/r/core/v1/pods?q=failed',
        grid: { namespaces: ['team-a'], columnVisibility: { labels: false }, columnWidths: { name: 240 }, sort: [{ field: 'name', sort: 'asc' }] },
      },
    ],
  });
  useTabsStore.setState({ tabs: [{ id: 'tab-1', path: '/' }], activeId: 'tab-1', closedPaths: [] });
  scrollIntoViewMock.mockClear();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoViewMock });
});

function renderDrawer(initial = '/r/appstore.eda.nokia.com/v1beta2/widgets', props = {}) {
  const onClose = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={[initial]}>
      <NavDrawer overlay={false} hidden={false} open onClose={onClose} {...props} />
      <LocationProbe />
    </MemoryRouter>,
  );
  return { ...view, onClose };
}

describe('NavDrawer', () => {
  it('renders built-in, custom, favorite, and saved-view navigation', async () => {
    renderDrawer();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getAllByText('Pods').length).toBeGreaterThan(1);
    expect(screen.getByText('Failing pods')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Custom Resources'));
    fireEvent.click(screen.getByText('Custom Resources'));
    expect(await screen.findByText('nokia.com')).toBeInTheDocument();
    fireEvent.click(screen.getByText('nokia.com'));
    expect(screen.getByText('appstore.eda')).toBeInTheDocument();
    fireEvent.click(screen.getByText('appstore.eda'));
    expect(screen.getByText('Widget')).toBeInTheDocument();

    const filter = screen.getByPlaceholderText('Filter resources…');
    fireEvent.change(filter, { target: { value: 'widget' } });
    await waitFor(() => expect(screen.queryByText('Services')).not.toBeInTheDocument());
    expect(screen.getByText('Widget')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Clear resource filter'));
    expect(filter).toHaveValue('');
    fireEvent.keyDown(filter, { key: 'Escape' });
    fireEvent.change(filter, { target: { value: 'pod' } });
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(filter).toHaveValue('');

    fireEvent.click(screen.getByLabelText('Add favorite category Network'));
    expect(useNavigationStore.getState().favorites.some((favorite) => favorite.id === 'category:Network')).toBe(true);
    fireEvent.click(screen.getAllByLabelText('Remove favorite category Workloads')[0]!);
    expect(useNavigationStore.getState().favorites.some((favorite) => favorite.id === 'category:Workloads')).toBe(false);

    fireEvent.click(screen.getByLabelText('Delete saved view Failing pods'));
    expect(useNavigationStore.getState().savedViews).toEqual([]);
  }, 15_000);

  it('opens links in page tabs, handles favorite hotkeys, and reorders favorites', () => {
    renderDrawer('/');
    const podsLinks = screen.getAllByRole('link', { name: /Pods/ });
    fireEvent.click(podsLinks[0]!, { ctrlKey: true });
    expect(useTabsStore.getState().tabs.some((tab) => tab.path === '/r/core/v1/pods')).toBe(true);
    fireEvent(podsLinks[0]!, new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true });
    expect(screen.getByTestId('location')).toHaveTextContent('/r/core/v1/pods');
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: '0', code: 'Digit0', ctrlKey: true });

    const source = screen.getByLabelText('Reorder favorite Pods');
    const target = screen.getByLabelText('Reorder favorite Legacy');
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(source, { dataTransfer });
    const dropShell = target.closest('.MuiBox-root')?.parentElement ?? target.parentElement!;
    fireEvent.dragOver(dropShell, { clientY: 0, dataTransfer });
    fireEvent.dragLeave(dropShell, { relatedTarget: document.body, dataTransfer });
    fireEvent.dragOver(dropShell, { clientY: 100, dataTransfer });
    fireEvent.drop(dropShell, { clientY: 100, dataTransfer });
    fireEvent.dragEnd(source, { dataTransfer });
    expect(useNavigationStore.getState().favorites.map((favorite) => favorite.id)).toContain('kind:/v1/pods');
  }, 15_000);

  it('keeps the canonical panel entry collapsed when navigating from a favorite', async () => {
    renderDrawer('/');
    const workloadHeaders = screen.getAllByRole('button', { name: 'Workloads' });
    const openWorkloads = workloadHeaders.find((header) => header.getAttribute('aria-expanded') === 'true');
    expect(openWorkloads).toBeDefined();
    fireEvent.click(openWorkloads!);

    await waitFor(() => expect(screen.getAllByRole('link', { name: /Pods/ })).toHaveLength(1), { timeout: 10_000 });
    const favorite = screen.getByRole('link', { name: /Pods/ });
    fireEvent.click(favorite);

    expect(screen.getByTestId('location')).toHaveTextContent('/r/core/v1/pods');
    expect(favorite).toHaveClass('Mui-selected');
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Pods/ })).toHaveLength(1));
  }, 15_000);

  it('prefers the matching favorite when tab navigation restores only the URL', async () => {
    renderDrawer('/r/core/v1/pods');

    const [favorite, canonical] = screen.getAllByRole('link', { name: /Pods/ });
    expect(favorite).toHaveClass('Mui-selected');
    expect(canonical).not.toHaveClass('Mui-selected');

    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    expect(scrollIntoViewMock.mock.instances[0]).toBe(favorite);
  });

  it('reveals a matching child of a collapsed favorite category', async () => {
    useNavigationStore.setState({
      favorites: [{ id: 'category:Workloads', title: 'Workloads' }],
      savedViews: [],
    });
    renderDrawer('/r/core/v1/pods');

    const [favorite, canonical] = await screen.findAllByRole('link', { name: /Pods/ });
    expect(favorite).toHaveClass('Mui-selected');
    expect(canonical).not.toHaveClass('Mui-selected');
    expect(screen.getAllByRole('button', { name: 'Workloads' })[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it('scopes a favorite to a cluster from its menu and hides it elsewhere', async () => {
    const legacy = () => useNavigationStore.getState().favorites.find((favorite) => favorite.id === 'legacy');
    const { unmount } = renderDrawer('/');
    // The star on a favorite opens its menu rather than removing it outright.
    fireEvent.click(screen.getByLabelText('Remove or edit favorite Legacy'));
    fireEvent.click(await screen.findByText('eda'));
    expect(legacy()?.scopes).toEqual(['eda']);
    // Scoped away from the connected cluster, the entry leaves the sidebar.
    // (Its title lives on in the open menu's header, so match links only.)
    await waitFor(() => expect(screen.queryAllByRole('link', { name: /Legacy/ })).toHaveLength(0));
    unmount();

    useClustersStore.setState({ selected: ['eda'] });
    renderDrawer('/');
    expect(screen.getAllByText('Legacy')[0]).toBeInTheDocument();
    // Reverting to all clusters puts it back everywhere.
    fireEvent.contextMenu(screen.getAllByText('Legacy')[0]!);
    fireEvent.click(await screen.findByText('All clusters'));
    expect(legacy()?.scopes).toBeUndefined();
    // Removing is now an item in the same menu.
    fireEvent.click(screen.getByLabelText('Remove or edit favorite Legacy'));
    fireEvent.click(await screen.findByText('Remove favorite'));
    expect(legacy()).toBeUndefined();
  }, 15_000);

  it('drops kind favorites no connected cluster serves', () => {
    useNavigationStore.setState({
      favorites: [
        { id: 'kind:topo.eda.nokia.com/v1/links', title: 'TopoLinks', path: '/r/topo.eda.nokia.com/v1/links' },
        { id: 'kind:/v1/pods', title: 'Pods', path: '/r/core/v1/pods' },
      ],
      savedViews: [],
    });
    // Discovery for the connected cluster knows nothing of the eda CRD.
    queryMocks.byContext = { dev: [{ group: '', version: 'v1', plural: 'pods', kind: 'Pod', namespaced: true, verbs: ['list'] }] };
    renderDrawer('/');
    expect(screen.queryByText('TopoLinks')).not.toBeInTheDocument();
    expect(screen.getAllByText('Pods').length).toBeGreaterThan(0);
  });

  it('lists served built-in kinds without a fixed group under a collapsed More built-in kinds group', async () => {
    const watch = ['get', 'list', 'watch'];
    queryMocks.resources = [
      ...customResources,
      { group: 'coordination.k8s.io', version: 'v1', plural: 'leases', kind: 'Lease', namespaced: true, verbs: watch, custom: false },
      { group: 'scheduling.k8s.io', version: 'v1', plural: 'priorityclasses', kind: 'PriorityClass', namespaced: false, verbs: watch, custom: false },
      { group: 'events.k8s.io', version: 'v1', plural: 'events', kind: 'Event', namespaced: true, verbs: watch, custom: false },
      { group: 'metrics.k8s.io', version: 'v1beta1', plural: 'pods', kind: 'PodMetrics', namespaced: true, verbs: ['get', 'list'], custom: false },
    ];
    renderDrawer('/');
    const header = screen.getByRole('button', { name: 'More built-in kinds' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Leases')).not.toBeInTheDocument();

    // The nav filter finds them without opening the group first.
    const filter = screen.getByPlaceholderText('Filter resources…');
    fireEvent.change(filter, { target: { value: 'lease' } });
    expect(await screen.findByRole('link', { name: 'Leases' })).toHaveAttribute('href', '/r/coordination.k8s.io/v1/leases');
    expect(screen.queryByText('PriorityClasses')).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: '' } });

    fireEvent.click(header);
    expect(await screen.findByText('PriorityClasses')).toBeInTheDocument();
    expect(screen.getByText('Leases')).toBeInTheDocument();
    expect(screen.queryByText('PodMetrics')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Add favorite category More built-in kinds'));
    expect(useNavigationStore.getState().favorites.some((favorite) => favorite.id === 'category:More built-in kinds')).toBe(true);
  });

  it('opens the More built-in kinds group when a kind in it is the current page', async () => {
    queryMocks.resources = [
      { group: 'coordination.k8s.io', version: 'v1', plural: 'leases', kind: 'Lease', namespaced: true, verbs: ['list', 'watch'], custom: false },
    ];
    renderDrawer('/r/coordination.k8s.io/v1/leases');
    expect(await screen.findByRole('link', { name: 'Leases' })).toHaveAttribute('aria-current', 'page');
  });

  it('supports overlay close behavior and the hidden permanent rail', async () => {
    const overlay = renderDrawer('/events', { overlay: true, open: true });
    await waitFor(() => expect(overlay.onClose).toHaveBeenCalled());
    overlay.unmount();

    const hidden = renderDrawer('/', { hidden: true, open: false });
    expect(screen.getByText('Overview')).toBeInTheDocument();
    hidden.unmount();
  });

  it('shows a GitOps group only while Argo CD or Flux is installed, and reveals it on navigation', () => {
    const rollouts = { group: 'argoproj.io', version: 'v1alpha1', plural: 'rollouts', kind: 'Rollout', namespaced: true, verbs: ['list'], custom: true };
    queryMocks.resources = [...customResources, rollouts];
    const plain = renderDrawer('/');
    expect(screen.queryByText('GitOps')).not.toBeInTheDocument();
    plain.unmount();

    queryMocks.resources = [
      ...customResources,
      rollouts,
      { group: 'argoproj.io', version: 'v1alpha1', plural: 'applications', kind: 'Application', namespaced: true, verbs: ['list'], custom: true },
      { group: 'kustomize.toolkit.fluxcd.io', version: 'v1', plural: 'kustomizations', kind: 'Kustomization', namespaced: true, verbs: ['list'], custom: true },
    ];
    renderDrawer('/r/kustomize.toolkit.fluxcd.io/v1/kustomizations');
    expect(screen.getByText('GitOps')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Applications/ })).toHaveAttribute('href', '/r/argoproj.io/v1alpha1/applications');
    expect(screen.getByRole('link', { name: /Kustomizations/ })).toHaveClass('Mui-selected');
    // Rollouts are progressive delivery, not GitOps: they stay under Custom Resources only.
    expect(screen.queryByRole('link', { name: /Rollouts/ })).not.toBeInTheDocument();
  }, 15_000);
});
