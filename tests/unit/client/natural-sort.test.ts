import type { GridColDef } from '@mui/x-data-grid';
import { describe, expect, it } from 'vitest';
import { naturalCompare, naturalSortComparator, withNaturalSort } from '../../../client/src/components/natural-sort';

describe('naturalCompare', () => {
  it('orders digit runs by value', () => {
    const names = ['worker-10', 'worker-2', 'worker-1', 'worker-12', 'worker-3'];
    expect([...names].sort(naturalCompare)).toEqual(['worker-1', 'worker-2', 'worker-3', 'worker-10', 'worker-12']);
  });

  it('keeps StatefulSet ordinals in order', () => {
    const pods = Array.from({ length: 12 }, (_, i) => `x-${12 - i}`);
    expect([...pods].sort(naturalCompare)).toEqual(Array.from({ length: 12 }, (_, i) => `x-${i + 1}`));
  });

  it('compares several numeric runs independently', () => {
    expect(['v1.10.0', 'v1.9.2', 'v1.9.10'].sort(naturalCompare)).toEqual(['v1.9.2', 'v1.9.10', 'v1.10.0']);
  });

  it('puts empty values first', () => {
    expect(['b', '', 'a', null].sort(naturalCompare)).toEqual(['', null, 'a', 'b']);
    expect(naturalCompare(undefined, 'a')).toBeLessThan(0);
    expect(naturalCompare('a', null)).toBeGreaterThan(0);
    expect(naturalCompare('', undefined)).toBe(0);
  });

  it('compares numbers numerically and mixed values as text', () => {
    expect(naturalCompare(2, 10)).toBeLessThan(0);
    expect(naturalCompare('2', 10)).toBeLessThan(0);
  });

  it('keeps ISO timestamps in chronological order', () => {
    const times = ['2026-09-29T10:00:00Z', '2026-01-02T09:00:00Z', '2025-12-31T23:59:59Z'];
    expect([...times].sort(naturalCompare)).toEqual([...times].sort());
  });
});

describe('withNaturalSort', () => {
  it('adds the comparator to text columns', () => {
    const col = withNaturalSort({ field: 'name' } as GridColDef);
    expect(col.sortComparator).toBe(naturalSortComparator);
    expect(withNaturalSort({ field: 'x', type: 'string' } as GridColDef).sortComparator).toBe(naturalSortComparator);
  });

  it('leaves numeric columns and custom comparators alone', () => {
    const numeric = { field: 'restarts', type: 'number' } as GridColDef;
    expect(withNaturalSort(numeric)).toBe(numeric);
    const custom = { field: 'x', sortComparator: () => 0 } as GridColDef;
    expect(withNaturalSort(custom)).toBe(custom);
  });
});
