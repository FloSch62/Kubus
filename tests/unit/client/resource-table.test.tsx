import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClusterRow } from '../../../client/src/api/queries';
import { ResourceTable } from '../../../client/src/components/ResourceTable';

vi.mock('../../../client/src/components/SmartFilterInput.js', () => ({ SmartFilterInput: () => null }));
vi.mock('../../../client/src/components/CellCopy.js', () => ({
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
});
