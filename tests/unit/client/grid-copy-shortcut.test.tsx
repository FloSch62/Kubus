import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterRow } from '../../../client/src/api/queries';
import { ResourceTable } from '../../../client/src/components/ResourceTable';

const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));

vi.mock('../../../client/src/clipboard.js', () => ({ copyToClipboard: clipboard.copy }));
vi.mock('../../../client/src/components/SmartFilterInput.js', () => ({ SmartFilterInput: () => null }));
vi.mock('../../../client/src/components/quick-search.js', () => ({ useQuickSearchShortcut: vi.fn() }));

function row(name: string): ClusterRow {
  return { ctx: 'dev', obj: { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'default', uid: `uid-${name}` } } };
}

const rows = [row('alpha'), row('beta')];
const columns = [{ field: 'name', headerName: 'Name', valueGetter: (_value: unknown, current: ClusterRow) => current.obj.metadata.name }];

function renderSelected() {
  return render(<ResourceTable rows={rows} columns={columns} checkboxSelection selectedRows={rows} onSelectionChange={vi.fn()} />);
}

describe('Ctrl+C in a resource table', () => {
  const writeText = vi.fn(async () => undefined);
  beforeEach(() => {
    clipboard.copy.mockClear();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  it('copies only the focused cell, even with rows checked', async () => {
    renderSelected();
    const cell = screen.getByText('alpha').closest('.MuiDataGrid-cell')!;
    // keyCode as real browsers send it; the grid's own handler keys on it.
    fireEvent.keyDown(cell, { key: 'c', keyCode: 67, ctrlKey: true });
    await waitFor(() => expect(clipboard.copy).toHaveBeenCalledTimes(1));
    expect(clipboard.copy).toHaveBeenCalledWith('alpha');
    // The grid's own copy of the checked rows as TSV never runs.
    expect(writeText).not.toHaveBeenCalled();
    await waitFor(() => expect(cell).toHaveClass('kubus-cell-copied-flash'));
  });

  it('copies nothing from a focused row checkbox', () => {
    renderSelected();
    fireEvent.keyDown(screen.getAllByRole('checkbox')[1]!, { key: 'c', keyCode: 67, metaKey: true });
    expect(clipboard.copy).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('leaves other chords to the grid', () => {
    renderSelected();
    const cell = screen.getByText('alpha').closest('.MuiDataGrid-cell')!;
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    cell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboard.copy).not.toHaveBeenCalled();
  });
});
