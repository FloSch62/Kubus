import type { GridColDef } from '@mui/x-data-grid';
import type { KubeObject } from '@kubus/shared';
import { describe, expect, it } from 'vitest';
import type { ClusterRow } from '../../../client/src/api/queries';
import { buildColumns } from '../../../client/src/components/columns';
import { copyColumns, serializeRows } from '../../../client/src/components/row-copy';

function pod(name: string, extra: Partial<KubeObject['metadata']> = {}): ClusterRow {
  return {
    ctx: 'kind-a',
    obj: {
      metadata: { name, namespace: 'gap-lists', uid: `uid-${name}`, creationTimestamp: '2026-09-29T10:00:00Z', ...extra },
      spec: { nodeName: 'worker-1', containers: [{ name: 'app', image: 'nginx' }] },
      status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 3, state: { running: {} } }] },
    } as KubeObject,
  };
}

const actions: GridColDef<ClusterRow> = { field: '_actions', headerName: '' };
const signals: GridColDef<ClusterRow> = { field: 'signals', headerName: '', valueGetter: () => 4 };

describe('copyColumns', () => {
  const columns = [...buildColumns(['name', 'namespace', 'restarts', 'node', 'age'], { multiCluster: false }), signals, actions];

  it('keeps the named data columns in order', () => {
    expect(copyColumns(columns).map((c) => c.field)).toEqual(['name', 'namespace', 'restarts', 'node', 'age']);
  });

  it('follows default-hidden fields and the saved visibility model', () => {
    expect(copyColumns(columns, ['node']).map((c) => c.field)).toEqual(['name', 'namespace', 'restarts', 'age']);
    expect(copyColumns(columns, ['node'], { node: true, age: false }).map((c) => c.field)).toEqual(['name', 'namespace', 'restarts', 'node']);
  });
});

describe('serializeRows', () => {
  const columns = copyColumns(buildColumns(['name', 'namespace', 'restarts', 'node', 'age', 'labels'], { multiCluster: false }));

  it('writes TSV with a header and raw values', () => {
    const text = serializeRows([pod('web-1', { labels: { app: 'web' } }), pod('web-2')], columns, 'tsv');
    expect(text).toBe(
      [
        'Name\tNamespace\tRestarts\tNode\tAge\tLabels',
        'web-1\tgap-lists\t3\tworker-1\t2026-09-29T10:00:00Z\tapp=web',
        'web-2\tgap-lists\t3\tworker-1\t2026-09-29T10:00:00Z\t',
        '',
      ].join('\n'),
    );
  });

  it('quotes CSV fields holding the delimiter, quotes or line breaks', () => {
    const cols: GridColDef<ClusterRow>[] = [
      { field: 'name', headerName: 'Name', valueGetter: (_v, row) => row.obj.metadata.name },
      { field: 'note', headerName: 'Note, free text', valueGetter: (_v, row) => row.obj.metadata.annotations?.note ?? '' },
    ];
    const text = serializeRows([pod('a', { annotations: { note: 'say "hi", twice\nplease' } })], cols, 'csv');
    expect(text).toBe('Name,"Note, free text"\na,"say ""hi"", twice\nplease"\n');
  });

  it('quotes TSV fields holding tabs', () => {
    const cols: GridColDef<ClusterRow>[] = [{ field: 'x', headerName: 'X', valueGetter: () => 'a\tb' }];
    expect(serializeRows([pod('a')], cols, 'tsv')).toBe('X\n"a\tb"\n');
  });
});
