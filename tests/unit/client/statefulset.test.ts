import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { claimRows, podOrdinal, sortByOrdinal } from '../../../client/src/components/detail/statefulset';
import { podRevisionName, revisionRows } from '../../../client/src/components/detail/ControllerRevisions';

function set(replicas: number, templates: string[], extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: 'db', namespace: 'data', uid: 'sts' },
    spec: { replicas, volumeClaimTemplates: templates.map((name) => ({ metadata: { name }, spec: { storageClassName: 'fast', resources: { requests: { storage: '1Gi' } } } })), ...extra },
  } as KubeObject;
}

function pvc(name: string, phase: string, capacity?: string): KubeObject {
  return { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: 'data', uid: `pvc-${name}` }, spec: { storageClassName: 'fast' }, status: { phase, ...(capacity && { capacity: { storage: capacity } }) } } as KubeObject;
}

function pod(name: string, hash: string, ready = true): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'data', uid: `uid-${name}`, labels: { 'controller-revision-hash': hash } },
    spec: { containers: [{ name: 'db' }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'db', ready, state: { running: {} } }] },
  } as unknown as KubeObject;
}

function revision(name: string, number: number, image: string): KubeObject {
  return { apiVersion: 'apps/v1', kind: 'ControllerRevision', metadata: { name, namespace: 'data', uid: `cr-${name}` }, revision: number, data: { spec: { template: { spec: { containers: [{ name: 'db', image }] } } } } } as unknown as KubeObject;
}

describe('StatefulSet ordinals', () => {
  it('reads the ordinal from the pod name and sorts numerically', () => {
    expect(podOrdinal('db-10', 'db')).toBe(10);
    expect(podOrdinal('db-x', 'db')).toBeUndefined();
    expect(podOrdinal('other-1', 'db')).toBeUndefined();
    const names = sortByOrdinal([pod('db-10', 'h'), pod('db-2', 'h'), pod('db-0', 'h'), pod('stray', 'h')], 'db').map((p) => p.metadata.name);
    expect(names).toEqual(['db-0', 'db-2', 'db-10', 'stray']);
  });
});

describe('claimRows', () => {
  it('gives every template × ordinal a row, with missing and retained claims', () => {
    const rows = claimRows(set(2, ['data', 'wal']), [pvc('data-db-0', 'Bound', '1Gi'), pvc('wal-db-0', 'Bound', '1Gi'), pvc('data-db-1', 'Pending'), pvc('data-db-5', 'Bound', '1Gi'), pvc('data-other-0', 'Bound')]);
    expect(rows.map((r) => [r.claimName, r.ordinal, r.phase ?? 'none', r.capacity, r.retained])).toEqual([
      ['data-db-0', 0, 'Bound', '1Gi', false],
      ['wal-db-0', 0, 'Bound', '1Gi', false],
      // Unbound: the requested size stands in for capacity.
      ['data-db-1', 1, 'Pending', '1Gi', false],
      ['wal-db-1', 1, 'none', '1Gi', false],
      // Kept after a scale-down from six.
      ['data-db-5', 5, 'Bound', '1Gi', true],
    ]);
    expect(rows[3]!.pvc).toBeUndefined();
    expect(rows[0]!.storageClass).toBe('fast');
  });

  it('honours a custom start ordinal and has nothing to say without templates', () => {
    expect(claimRows(set(2, ['data'], { ordinals: { start: 3 } }), []).map((r) => r.claimName)).toEqual(['data-db-3', 'data-db-4']);
    expect(claimRows(set(3, []), [pvc('data-db-0', 'Bound')])).toEqual([]);
  });
});

describe('revisionRows', () => {
  it('matches pods by full revision name (StatefulSet) or hash suffix (DaemonSet)', () => {
    const names = new Set(['db-7d9f', 'agent-5c5c']);
    expect(podRevisionName(pod('db-0', 'db-7d9f'), 'db', names)).toBe('db-7d9f');
    expect(podRevisionName(pod('agent-x', '5c5c'), 'agent', names)).toBe('agent-5c5c');
    expect(podRevisionName(pod('agent-y', 'gone'), 'agent', names)).toBeUndefined();
  });

  it('lists revisions holding pods plus the update target, newest first', () => {
    const revisions = [revision('db-aaa', 1, 'db:1'), revision('db-bbb', 2, 'db:2'), revision('db-ccc', 3, 'db:3')];
    const pods = [pod('db-0', 'db-aaa'), pod('db-1', 'db-aaa', false), pod('db-2', 'db-ccc')];
    const { rows, hidden } = revisionRows(revisions, pods, 'db', 'db-ccc');
    expect(rows.map((r) => [r.revision, r.pods, r.ready, r.current, r.images])).toEqual([
      [3, 1, 1, true, ['db:3']],
      [1, 2, 1, false, ['db:1']],
    ]);
    expect(hidden).toBe(1);
    // Without an update revision the newest one is the target.
    expect(revisionRows(revisions, [], 'db').rows.map((r) => [r.revision, r.current])).toEqual([[3, true]]);
  });
});
