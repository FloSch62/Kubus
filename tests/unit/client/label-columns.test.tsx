import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { KubeObject } from '@kubus/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterRow } from '../../../client/src/api/queries';
import { buildLabelColumns, insertLabelColumns, labelColumnField, labelKeyCounts } from '../../../client/src/components/label-columns';
import { LabelColumnsButton } from '../../../client/src/components/LabelColumnsButton';
import { naturalSortComparator } from '../../../client/src/components/natural-sort';
import { applySavedViewGridState } from '../../../client/src/state/saved-view';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

function row(name: string, labels?: Record<string, string>, annotations?: Record<string, string>): ClusterRow {
  return { ctx: 'dev', obj: { metadata: { name, namespace: 'gap-lists', uid: `uid-${name}`, labels, annotations } } as KubeObject };
}

const rows = [
  row('web-1', { app: 'web', 'app.kubernetes.io/version': '1.10' }, { owner: 'team-a' }),
  row('web-2', { app: 'web', 'app.kubernetes.io/version': '1.9' }),
  row('db', { app: 'db' }),
];

describe('label columns', () => {
  it('builds one text column per key with the raw value', () => {
    const [version, owner] = buildLabelColumns([
      { source: 'label', key: 'app.kubernetes.io/version' },
      { source: 'annotation', key: 'owner' },
    ]);
    expect(version!.field).toBe('label:app.kubernetes.io/version');
    expect(version!.headerName).toBe('app.kubernetes.io/version');
    expect(version!.description).toBe('Label app.kubernetes.io/version');
    expect(rows.map((r) => version!.valueGetter!(undefined as never, r, version!, undefined as never))).toEqual(['1.10', '1.9', '']);
    expect(owner!.field).toBe(labelColumnField({ source: 'annotation', key: 'owner' }));
    expect(rows.map((r) => owner!.valueGetter!(undefined as never, r, owner!, undefined as never))).toEqual(['team-a', '', '']);
    // A plain text column: the grid adds natural sorting and its filters.
    expect(version!.type).toBeUndefined();
    expect(['1.10', '1.9', '1.2'].sort((a, b) => naturalSortComparator(a, b, undefined as never, undefined as never))).toEqual(['1.2', '1.9', '1.10']);
  });

  it('places added columns before Labels, else Age, else the row actions', () => {
    const added = [{ field: 'label:x' }];
    expect(insertLabelColumns([{ field: 'name' }, { field: 'labels' }, { field: 'age' }], added).map((c) => c.field)).toEqual(['name', 'label:x', 'labels', 'age']);
    expect(insertLabelColumns([{ field: 'name' }, { field: 'age' }, { field: '_actions' }], added).map((c) => c.field)).toEqual(['name', 'label:x', 'age', '_actions']);
    expect(insertLabelColumns([{ field: 'name' }], added).map((c) => c.field)).toEqual(['name', 'label:x']);
    const columns = [{ field: 'name' }];
    expect(insertLabelColumns(columns, [])).toBe(columns);
  });

  it('counts the keys present in the list, most common first', () => {
    expect(labelKeyCounts(rows, 'label')).toEqual([
      { key: 'app', count: 3 },
      { key: 'app.kubernetes.io/version', count: 2 },
    ]);
    expect(labelKeyCounts(rows, 'annotation')).toEqual([{ key: 'owner', count: 1 }]);
  });
});

describe('label column prefs', () => {
  beforeEach(() => useUiPrefsStore.setState({ labelColumns: {}, columnWidths: {}, columnVisibility: {}, sortModels: {} }));

  it('stores columns per table and drops empty lists', () => {
    const { setLabelColumns } = useUiPrefsStore.getState();
    setLabelColumns('/r/core/v1/pods', [{ source: 'label', key: 'app' }]);
    expect(useUiPrefsStore.getState().labelColumns).toEqual({ '/r/core/v1/pods': [{ source: 'label', key: 'app' }] });
    setLabelColumns('/r/core/v1/pods', []);
    expect(useUiPrefsStore.getState().labelColumns).toEqual({});
  });

  it('restores them from saved views, keeping current ones for views saved before they existed', () => {
    const path = '/r/core/v1/pods';
    useUiPrefsStore.getState().setLabelColumns(path, [{ source: 'label', key: 'app' }]);
    applySavedViewGridState(`${path}?q=web`, { namespaces: [] });
    expect(useUiPrefsStore.getState().labelColumns[path]).toEqual([{ source: 'label', key: 'app' }]);
    applySavedViewGridState(path, { labelColumns: [{ source: 'annotation', key: 'owner' }] });
    expect(useUiPrefsStore.getState().labelColumns[path]).toEqual([{ source: 'annotation', key: 'owner' }]);
    applySavedViewGridState(path, { labelColumns: [] });
    expect(useUiPrefsStore.getState().labelColumns[path]).toBeUndefined();
  });

  it('persists them with the other column prefs', () => {
    useUiPrefsStore.getState().setLabelColumns('/r/apps/v1/deployments', [{ source: 'label', key: 'team' }]);
    const stored = JSON.parse(localStorage.getItem('kubus-prefs') ?? '{}') as { state?: { labelColumns?: unknown } };
    expect(stored.state?.labelColumns).toEqual({ '/r/apps/v1/deployments': [{ source: 'label', key: 'team' }] });
  });
});

describe('LabelColumnsButton', () => {
  beforeEach(() => useUiPrefsStore.setState({ labelColumns: {}, columnVisibility: {} }));

  it('suggests keys from the list, adds and removes columns', async () => {
    render(<LabelColumnsButton tableId="t" rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a column for any label or annotation key' }));
    const input = await screen.findByRole('combobox', { name: 'Label key' });
    fireEvent.change(input, { target: { value: 'version' } });
    const option = await screen.findByRole('option', { name: /app\.kubernetes\.io\/version/ });
    expect(option).toHaveTextContent('2 of 3');
    fireEvent.click(option);
    expect(useUiPrefsStore.getState().labelColumns.t).toEqual([{ source: 'label', key: 'app.kubernetes.io/version' }]);

    // Any key can be typed, and annotations work the same way.
    fireEvent.click(screen.getByRole('button', { name: 'Annotation' }));
    const annotationInput = screen.getByRole('combobox', { name: 'Annotation key' });
    fireEvent.change(annotationInput, { target: { value: 'not-in-list' } });
    fireEvent.keyDown(annotationInput, { key: 'Enter' });
    expect(useUiPrefsStore.getState().labelColumns.t).toEqual([
      { source: 'label', key: 'app.kubernetes.io/version' },
      { source: 'annotation', key: 'not-in-list' },
    ]);

    const list = screen.getByText('not-in-list').closest('ul')!;
    fireEvent.click(within(list).getByRole('button', { name: 'Remove column app.kubernetes.io/version' }));
    await waitFor(() => expect(useUiPrefsStore.getState().labelColumns.t).toEqual([{ source: 'annotation', key: 'not-in-list' }]));
  });

  it('shows a re-added column even if it was hidden before', async () => {
    useUiPrefsStore.setState({ columnVisibility: { t: { 'label:team': false, name: true } } });
    render(<LabelColumnsButton tableId="t" rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a column for any label or annotation key' }));
    const input = await screen.findByRole('combobox', { name: 'Label key' });
    fireEvent.change(input, { target: { value: 'team' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useUiPrefsStore.getState().columnVisibility.t).toEqual({ 'label:team': true, name: true });
  });

  it('has an icon-only toolbar variant that can open the show/hide panel', async () => {
    useUiPrefsStore.setState({ labelColumns: { t: [{ source: 'label', key: 'app' }, { source: 'label', key: 'team' }] } });
    const onManageColumns = vi.fn();
    render(<LabelColumnsButton tableId="t" rows={rows} compact onManageColumns={onManageColumns} />);
    const button = screen.getByRole('button', { name: 'Columns' });
    expect(button).toHaveTextContent('2');
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: 'Show or hide columns…' }));
    expect(onManageColumns).toHaveBeenCalledTimes(1);
  });

  it('flags a key that is already a column', async () => {
    useUiPrefsStore.setState({ labelColumns: { t: [{ source: 'label', key: 'app' }] } });
    render(<LabelColumnsButton tableId="t" rows={rows} />);
    expect(screen.getByRole('button', { name: 'Add a column for any label or annotation key' })).toHaveTextContent('Columns (1)');
    fireEvent.click(screen.getByRole('button', { name: 'Add a column for any label or annotation key' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Label key' }), { target: { value: 'app' } });
    expect(screen.getByText('Already a column')).toBeInTheDocument();
  });
});
