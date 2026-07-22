import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavDrawer } from '../../../client/src/layout/NavDrawer';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useNavigationStore } from '../../../client/src/state/navigation';
import { useTabsStore } from '../../../client/src/state/tabs';

const queryMocks = vi.hoisted(() => ({
  resources: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useApiResourcesForContexts: () => ({
    data: { resources: queryMocks.resources, byContext: {}, errors: {} },
  }),
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
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
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

  it('supports overlay close behavior and the hidden permanent rail', async () => {
    const overlay = renderDrawer('/events', { overlay: true, open: true });
    await waitFor(() => expect(overlay.onClose).toHaveBeenCalled());
    overlay.unmount();

    const hidden = renderDrawer('/', { hidden: true, open: false });
    expect(screen.getByText('Overview')).toBeInTheDocument();
    hidden.unmount();
  });
});
