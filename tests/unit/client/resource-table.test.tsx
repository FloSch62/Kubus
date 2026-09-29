import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClusterRow } from '../../../client/src/api/queries';
import { ResourceTable } from '../../../client/src/components/ResourceTable';

vi.mock('../../../client/src/components/SmartFilterInput.js', () => ({ SmartFilterInput: () => null }));
vi.mock('../../../client/src/components/CellCopy.js', () => ({
  CellCopyOverlay: () => null,
  copyCellGridSx: {},
  handleCopyCellKeyDown: vi.fn(),
  withCellCopy: (column: unknown) => column,
}));
vi.mock('../../../client/src/components/quick-search.js', () => ({ useQuickSearchShortcut: vi.fn() }));

function row(name: string): ClusterRow {
  return {
    ctx: 'dev',
    obj: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, namespace: 'default', uid: `uid-${name}` },
    },
  };
}

describe('ResourceTable selection', () => {
  it('synchronizes the grid model when an external bulk action clears selected rows', () => {
    const first = row('first');
    const second = row('second');
    const columns = [{ field: 'name', valueGetter: (_value: unknown, current: ClusterRow) => current.obj.metadata.name }];
    const { rerender } = render(
      <ResourceTable rows={[first, second]} columns={columns} checkboxSelection selectedRows={[first, second]} onSelectionChange={vi.fn()} />,
    );

    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);

    rerender(<ResourceTable rows={[first, second]} columns={columns} checkboxSelection selectedRows={[]} onSelectionChange={vi.fn()} />);
    return waitFor(() => expect(screen.getAllByRole('checkbox').every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true));
  });

  it('holds watch updates out of the grid until scrolling settles', async () => {
    const first = row('first');
    const second = row('second');
    const columns = [{ field: 'name', valueGetter: (_value: unknown, current: ClusterRow) => current.obj.metadata.name }];
    const { container, rerender } = render(<ResourceTable rows={[first]} columns={columns} />);
    const scroller = container.querySelector('.MuiDataGrid-virtualScroller');
    expect(scroller).not.toBeNull();

    fireEvent.scroll(scroller!);
    rerender(<ResourceTable rows={[second]} columns={columns} />);
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.queryByText('second')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('second')).toBeInTheDocument());
    expect(screen.queryByText('first')).not.toBeInTheDocument();
  });

  it('holds refreshed metric cells until scrolling settles, then shows the latest value', async () => {
    const rows = [row('first')];
    const columns = (usage: string) => [{ field: 'cpu', renderCell: () => usage }];
    const { container, rerender } = render(<ResourceTable rows={rows} columns={columns('12m')} />);
    fireEvent.wheel(container.querySelector('.MuiDataGrid-virtualScroller')!);
    rerender(<ResourceTable rows={rows} columns={columns('18m')} />);
    expect(screen.getByText('12m')).toBeInTheDocument();
    expect(screen.queryByText('18m')).not.toBeInTheDocument();
    rerender(<ResourceTable rows={rows} columns={columns('24m')} />);
    await waitFor(() => expect(screen.getByText('24m')).toBeInTheDocument());
    expect(screen.queryByText('12m')).not.toBeInTheDocument();
    expect(screen.queryByText('18m')).not.toBeInTheDocument();
  });

});

describe('ResourceTable row keys', () => {
  const columns = [{ field: 'name', valueGetter: (_value: unknown, current: ClusterRow) => current.obj.metadata.name }];
  const nameCell = (name: string) => screen.getByText(name).closest<HTMLElement>('.MuiDataGrid-cell')!;

  it('moves the row cursor with j and k', async () => {
    render(<ResourceTable rows={[row('a'), row('b'), row('c')]} columns={columns} />);
    // Keys act on the focused cell, as in the app (Tab or a click puts focus there).
    act(() => nameCell('a').focus());
    fireEvent.keyDown(nameCell('a'), { key: 'j' });
    await waitFor(() => expect(document.activeElement).toBe(nameCell('b')));
    fireEvent.keyDown(nameCell('b'), { key: 'j' });
    await waitFor(() => expect(document.activeElement).toBe(nameCell('c')));
    // The last row stays put, like the arrow keys at the end of a page.
    fireEvent.keyDown(nameCell('c'), { key: 'j' });
    fireEvent.keyDown(nameCell('c'), { key: 'k' });
    await waitFor(() => expect(document.activeElement).toBe(nameCell('b')));
  });

  it('hands action keys to the page and claims only the ones the row has', () => {
    const onRowKey = vi.fn((current: ClusterRow, action: string) => action !== 'scale');
    render(<ResourceTable rows={[row('a'), row('b')]} columns={columns} onRowKey={onRowKey} />);

    const logs = new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true });
    nameCell('b').dispatchEvent(logs);
    expect(onRowKey).toHaveBeenLastCalledWith(expect.objectContaining({ obj: expect.objectContaining({ metadata: expect.objectContaining({ name: 'b' }) }) }), 'logs');
    expect(logs.defaultPrevented).toBe(true);

    // No such action on the row: the key stays free for the filter shortcut.
    const scale = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
    nameCell('a').dispatchEvent(scale);
    expect(onRowKey).toHaveBeenLastCalledWith(expect.anything(), 'scale');
    expect(scale.defaultPrevented).toBe(false);

    // Chords, held keys and other keys never reach the page.
    onRowKey.mockClear();
    fireEvent.keyDown(nameCell('a'), { key: 'l', ctrlKey: true });
    fireEvent.keyDown(nameCell('a'), { key: 'l', repeat: true });
    fireEvent.keyDown(nameCell('a'), { key: 'q' });
    expect(onRowKey).not.toHaveBeenCalled();
    fireEvent.keyDown(nameCell('a'), { key: 'Delete' });
    expect(onRowKey).toHaveBeenLastCalledWith(expect.anything(), 'delete');
  });
});

describe('ResourceTable empty state', () => {
  it('links an empty custom resource list to its definition, but not while filters hide rows', async () => {
    const columns = [{ field: 'name', valueGetter: (_value: unknown, current: ClusterRow) => current.obj.metadata.name }];
    const openDefinition = vi.fn();
    const { rerender } = render(<ResourceTable rows={[]} columns={columns} onOpenDefinition={openDefinition} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open definition' }));
    expect(openDefinition).toHaveBeenCalledTimes(1);

    rerender(<ResourceTable rows={[row('hidden')]} columns={columns} filter="nothing-matches" onOpenDefinition={openDefinition} />);
    expect(await screen.findByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open definition' })).not.toBeInTheDocument();

    rerender(<ResourceTable rows={[]} columns={columns} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open definition' })).not.toBeInTheDocument());
  });
});

