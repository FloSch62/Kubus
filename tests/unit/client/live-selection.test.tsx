import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import type { KubeObject } from '@kubus/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterRow } from '../../../client/src/api/queries';
import { CopyRowsButton } from '../../../client/src/components/CopyRowsButton';
import { liveSelection } from '../../../client/src/components/live-selection';
import { ResourceTable } from '../../../client/src/components/ResourceTable';
import { orderRows } from '../../../client/src/components/row-copy';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

const effects = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }));

vi.mock('../../../client/src/clipboard.js', () => ({ copyToClipboard: effects.copy }));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../../client/src/components/SmartFilterInput.js', () => ({ SmartFilterInput: () => null }));
vi.mock('../../../client/src/components/quick-search.js', () => ({ useQuickSearchShortcut: vi.fn() }));

function deployment(name: string, replicas: number): ClusterRow {
  return { ctx: 'dev', obj: { metadata: { name, namespace: 'gap-lists', uid: `uid-${name}` }, spec: { replicas } } as KubeObject };
}

describe('liveSelection', () => {
  it('swaps checked snapshots for the live rows and drops rows that are gone', () => {
    const checked = [deployment('api', 0), deployment('web', 1), deployment('gone', 1)];
    const live = [deployment('web', 1), deployment('api', 3), deployment('other', 2)];
    const out = liveSelection(checked, live);
    expect(out.map((r) => [r.obj.metadata.name, (r.obj.spec as { replicas: number }).replicas])).toEqual([
      ['api', 3],
      ['web', 1],
    ]);
    expect(out[0]).toBe(live[1]);
  });

  it('returns the checked array itself when nothing changed', () => {
    const live = [deployment('api', 0)];
    const checked = [live[0]!];
    expect(liveSelection(checked, live)).toBe(checked);
    const none: ClusterRow[] = [];
    expect(liveSelection(none, live)).toBe(none);
  });
});

describe('orderRows', () => {
  const id = (row: ClusterRow) => row.obj.metadata.uid;

  it('follows the grid order and keeps unknown rows last in their own order', () => {
    const rows = [deployment('b', 1), deployment('x', 1), deployment('a', 1), deployment('y', 1)];
    expect(orderRows(rows, id, ['uid-a', 'uid-c', 'uid-b']).map((r) => r.obj.metadata.name)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('leaves rows alone without a grid order', () => {
    const rows = [deployment('b', 1), deployment('a', 1)];
    expect(orderRows(rows, id, undefined)).toBe(rows);
    expect(orderRows(rows, id, [])).toBe(rows);
  });
});

function Harness({ rows, selected }: { rows: ClusterRow[]; selected: ClusterRow[] }) {
  const apiRef = useRef(null);
  const columns = [{ field: 'name', headerName: 'Name', valueGetter: (_v: unknown, row: ClusterRow) => row.obj.metadata.name }];
  return (
    <>
      <CopyRowsButton
        rows={selected}
        columns={columns}
        tableId="copy-order"
        sortedRowIds={() => (apiRef.current as { getSortedRowIds: () => string[] } | null)?.getSortedRowIds()}
      />
      <ResourceTable tableId="copy-order" rows={rows} columns={columns} checkboxSelection selectedRows={selected} onSelectionChange={vi.fn()} apiRef={apiRef} />
    </>
  );
}

describe('Copy rows order', () => {
  beforeEach(() => {
    effects.copy.mockClear();
    useUiPrefsStore.setState({ sortModels: {} });
  });

  async function copyTsv() {
    fireEvent.click(screen.getByRole('button', { name: /Copy rows/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /As TSV/ }));
    await waitFor(() => expect(effects.copy).toHaveBeenCalled());
    return effects.copy.mock.calls.at(-1)![0];
  }

  it('copies checked rows in the order the grid sorts them', async () => {
    const rows = [deployment('web-10', 1), deployment('web-2', 1), deployment('web-1', 1)];
    // Checked in a different order than any sort.
    render(<Harness rows={rows} selected={[rows[0]!, rows[2]!, rows[1]!]} />);
    expect(await copyTsv()).toBe('Name\nweb-1\nweb-2\nweb-10\n');

    effects.copy.mockClear();
    useUiPrefsStore.getState().setSortModel('copy-order', [{ field: 'name', sort: 'desc' }]);
    await waitFor(() => expect(screen.getAllByRole('gridcell')[1]).toHaveTextContent('web-10'));
    expect(await copyTsv()).toBe('Name\nweb-10\nweb-2\nweb-1\n');
  }, 15_000);
});
