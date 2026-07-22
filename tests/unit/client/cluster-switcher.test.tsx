import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClusterSwitcher } from '../../../client/src/layout/ClusterSwitcher';
import { useClustersStore } from '../../../client/src/state/clusters';

const queryMocks = vi.hoisted(() => ({
  contexts: [] as Array<Record<string, unknown>>,
  connect: { mutate: vi.fn(), isPending: false, variables: undefined as unknown },
  reconnect: { mutate: vi.fn(), isPending: false, variables: undefined as unknown },
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useContexts: () => ({ data: queryMocks.contexts }),
  useConnectContext: () => queryMocks.connect,
  useReconnectContext: () => queryMocks.reconnect,
}));

const contexts = [
  { name: 'dev-eu', cluster: 'dev-cluster', server: 'https://dev.example.test', current: true, active: true, health: 'connected', kubernetesVersion: 'v1.32.1' },
  { name: 'prod-eu', cluster: 'prod-cluster', server: 'https://prod.example.test', current: false, active: false, health: 'error', kubernetesVersion: 'v1.31.5' },
  { name: 'stage-us', cluster: 'stage-cluster', current: false, active: true, health: 'connecting' },
  { name: 'lab', cluster: 'lab-cluster', current: false, active: true, health: 'unknown' },
];

beforeEach(() => {
  queryMocks.contexts = contexts;
  queryMocks.connect.mutate.mockClear();
  queryMocks.connect.isPending = false;
  queryMocks.connect.variables = undefined;
  queryMocks.reconnect.mutate.mockClear();
  queryMocks.reconnect.isPending = false;
  queryMocks.reconnect.variables = undefined;
  useClustersStore.setState({
    selected: ['dev-eu', 'removed'],
    namespaces: [],
    contextSettings: {
      'dev-eu': { group: 'Development', icon: '🧪' },
      'prod-eu': { group: 'Production', protected: true, icon: '🏭' },
      'stage-us': { group: 'Development' },
    },
    contextOrder: ['prod-eu', 'dev-eu', 'stage-us', 'lab'],
    pickerLayout: 'list',
  });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

describe('ClusterSwitcher', () => {
  it('filters, selects, reconnects, customizes, reorders, and switches layouts', async () => {
    render(<ClusterSwitcher />);
    await waitFor(() => expect(useClustersStore.getState().selected).toEqual(['dev-eu']));
    expect(screen.getByRole('button', { name: /dev-eu/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dev-eu/i }));
    const search = await screen.findByPlaceholderText('Search contexts…');
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select prod-eu'));
    expect(queryMocks.connect.mutate).toHaveBeenCalledWith({ ctx: 'prod-eu', connect: true });
    fireEvent.click(screen.getByLabelText('Reconnect dev-eu'));
    expect(queryMocks.reconnect.mutate).toHaveBeenCalledWith('dev-eu');

    fireEvent.change(search, { target: { value: 'prod' } });
    expect(screen.getByText('Select matches (1)')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'PageDown' });
    fireEvent.keyDown(search, { key: 'PageUp' });
    fireEvent.keyDown(search, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');

    fireEvent.keyDown(search, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(search, { key: ' ' });
    fireEvent.keyDown(search, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(search, { key: 'ArrowUp', altKey: true });
    expect(useClustersStore.getState().contextOrder).toHaveLength(4);

    fireEvent.click(screen.getByLabelText('Select group Development'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useClustersStore.getState().selected).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(useClustersStore.getState().selected).toEqual(expect.arrayContaining(['dev-eu', 'prod-eu', 'stage-us', 'lab']));

    const devRow = screen.getByText('dev-eu').closest('[draggable="true"]');
    const stageRow = screen.getByText('stage-us').closest('[draggable="true"]');
    const transfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(devRow!, { dataTransfer: transfer });
    fireEvent.dragOver(stageRow!, { clientY: 0, dataTransfer: transfer });
    fireEvent.drop(stageRow!, { clientY: 0, dataTransfer: transfer });
    fireEvent.dragEnd(devRow!, { dataTransfer: transfer });

    fireEvent.click(screen.getByLabelText('Grid layout'));
    expect(useClustersStore.getState().pickerLayout).toBe('grid');
    fireEvent.keyDown(search, { key: 'ArrowRight' });
    fireEvent.keyDown(search, { key: 'ArrowLeft' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.click(screen.getByLabelText('List layout'));

    fireEvent.click(screen.getByLabelText('Customize dev-eu'));
    expect(await screen.findByText('Icon')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'No icon' }));
    expect(useClustersStore.getState().contextSettings['dev-eu']?.icon).toBeUndefined();
  }, 15_000);

  it('restores the current context and renders empty and no-match states', async () => {
    useClustersStore.setState({ selected: [], contextSettings: {}, contextOrder: [], pickerLayout: 'grid' });
    const view = render(<ClusterSwitcher />);
    await waitFor(() => expect(useClustersStore.getState().selected).toEqual(['dev-eu']));
    fireEvent.click(screen.getByRole('button', { name: /dev-eu/i }));
    const search = await screen.findByPlaceholderText('Search contexts…');
    fireEvent.change(search, { target: { value: 'does-not-exist' } });
    expect(screen.getByText(/No contexts match/)).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });
    queryMocks.contexts = [];
    act(() => view.rerender(<ClusterSwitcher />));
    expect(screen.getByText(/No contexts found in kubeconfig/)).toBeInTheDocument();
  });
});
