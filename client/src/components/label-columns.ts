import type { GridColDef } from '@mui/x-data-grid';
import type { KubeObject, LabelColumnSpec } from '@kubus/shared';
import type { ClusterRow } from '../api/queries.js';

/** Grid field of a label or annotation column, distinct from every preset column id. */
export function labelColumnField(spec: LabelColumnSpec): string {
  return `${spec.source}:${spec.key}`;
}

function valuesOf(obj: KubeObject, source: LabelColumnSpec['source']): Record<string, string> | undefined {
  return source === 'label' ? obj.metadata.labels : obj.metadata.annotations;
}

/**
 * One text column per spec. The value is the raw label or annotation value,
 * so the column sorts (naturally), filters and copies like any other.
 */
export function buildLabelColumns(specs: LabelColumnSpec[]): GridColDef<ClusterRow>[] {
  return specs.map((spec) => ({
    field: labelColumnField(spec),
    headerName: spec.key,
    description: `${spec.source === 'label' ? 'Label' : 'Annotation'} ${spec.key}`,
    // Wide enough for the whole key in the header (sort and menu icons included).
    width: Math.min(280, Math.max(140, Math.round(spec.key.length * 7.5) + 48)),
    minWidth: 80,
    valueGetter: (_v, row) => valuesOf(row.obj, spec.source)?.[spec.key] ?? '',
  }));
}

/**
 * Place added columns just before the Labels column, falling back to before
 * Age, before the row actions, or at the end.
 */
export function insertLabelColumns<C extends { field: string }>(columns: C[], added: C[]): C[] {
  if (!added.length) return columns;
  const at = ['labels', 'age', '_actions'].map((field) => columns.findIndex((c) => c.field === field)).find((i) => i !== -1) ?? columns.length;
  return [...columns.slice(0, at), ...added, ...columns.slice(at)];
}

export function sameLabelColumn(a: LabelColumnSpec, b: LabelColumnSpec): boolean {
  return a.source === b.source && a.key === b.key;
}

/** Keys of the given source present in the rows, most common first, with how many rows carry each. */
export function labelKeyCounts(rows: ClusterRow[], source: LabelColumnSpec['source']): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of Object.keys(valuesOf(row.obj, source) ?? {})) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
