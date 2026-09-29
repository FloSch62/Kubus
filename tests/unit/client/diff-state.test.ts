import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  DEFAULT_DIFF_OPTIONS,
  adoptKind,
  defaultRightSide,
  diffPath,
  diffView,
  encodeSide,
  parseSide,
  pickKind,
  readDiffState,
  sameKind,
  sideComplete,
  sideLabel,
  withKind,
} from '../../../client/src/diff-state';
import { tabMeta } from '../../../client/src/layout/tab-meta';

const deploy = { ctx: 'kind-a', group: 'apps', version: 'v1', plural: 'deployments', namespace: 'shop', name: 'web' };

describe('diff side encoding', () => {
  it('round-trips a side through the URL format', () => {
    expect(encodeSide(deploy)).toBe('kind-a|apps/v1/deployments|shop|web');
    expect(parseSide(encodeSide(deploy)!)).toEqual(deploy);
  });

  it('uses the core sentinel and drops the namespace for cluster-scoped kinds', () => {
    const node = { ctx: 'kind-a', group: '', version: 'v1', plural: 'nodes', name: 'worker' };
    expect(encodeSide(node)).toBe('kind-a|core/v1/nodes||worker');
    expect(parseSide('kind-a|core/v1/nodes||worker')).toEqual(node);
  });

  it('keeps partial picks and tolerates a pipe in the context name', () => {
    expect(parseSide('prod|eu|apps/v1/deployments||')).toEqual({ ctx: 'prod|eu', group: 'apps', version: 'v1', plural: 'deployments' });
    expect(parseSide('kind-a|||')).toEqual({ ctx: 'kind-a' });
    expect(parseSide('garbage')).toEqual({});
    expect(parseSide(null)).toEqual({});
    expect(encodeSide({})).toBeUndefined();
  });
});

describe('diff URL state', () => {
  it('leaves defaults out of the URL', () => {
    expect(diffPath({ left: deploy })).toBe('/diff?left=kind-a%7Capps%2Fv1%2Fdeployments%7Cshop%7Cweb');
    expect(diffPath({})).toBe('/diff');
  });

  it('reads back every option it writes', () => {
    const path = diffPath({ left: deploy, right: { ...deploy, ctx: 'kind-b' }, options: { normalize: false, specOnly: true, onlyChanges: true, syncKind: false } });
    const state = readDiffState(new URLSearchParams(path.slice('/diff'.length)));
    expect(state).toEqual({
      left: deploy,
      right: { ...deploy, ctx: 'kind-b' },
      options: { normalize: false, specOnly: true, onlyChanges: true, syncKind: false },
    });
    expect(path).toContain('kinds=separate');
    expect(readDiffState(new URLSearchParams()).options).toEqual({ normalize: true, specOnly: false, onlyChanges: false, syncKind: true });
  });

  it('names a compare tab after what it compares', () => {
    expect(tabMeta(diffPath({ left: deploy, right: { ...deploy, ctx: 'kind-b' } })).title).toBe('Diff: web');
    expect(tabMeta(diffPath({ left: deploy, right: { ...deploy, name: 'api' } })).title).toBe('Diff: web ↔ api');
    expect(tabMeta('/diff').title).toBe('Diff');
  });
});

describe('kind sync', () => {
  const configmaps = { group: '', version: 'v1', plural: 'configmaps', namespaced: true };
  const nodes = { group: '', version: 'v1', plural: 'nodes', namespaced: false };
  const synced = { ...DEFAULT_DIFF_OPTIONS, syncKind: true };
  const staging = { ...deploy, namespace: 'staging' };

  it('picks the kind on the other side too, keeping its cluster and namespace', () => {
    const next = pickKind({ left: deploy, right: { ...staging, ctx: 'kind-b' }, options: synced }, 'left', configmaps);
    expect(next.left).toEqual({ ctx: 'kind-a', group: '', version: 'v1', plural: 'configmaps', namespace: 'shop' });
    expect(next.right).toEqual({ ctx: 'kind-b', group: '', version: 'v1', plural: 'configmaps', namespace: 'staging' });
  });

  it('drops namespaces for a cluster-scoped kind and leaves a side on that kind alone', () => {
    const next = pickKind({ left: deploy, right: { ctx: 'kind-b', group: '', version: 'v1', plural: 'nodes', name: 'n1' }, options: synced }, 'left', nodes);
    expect(next.left).toEqual({ ctx: 'kind-a', group: '', version: 'v1', plural: 'nodes', namespace: undefined });
    expect(next.right).toEqual({ ctx: 'kind-b', group: '', version: 'v1', plural: 'nodes', name: 'n1' });
  });

  it('touches only the picked side when the kinds are separate or the other side has no cluster', () => {
    const right = { ...staging, ctx: 'kind-b' };
    expect(pickKind({ left: deploy, right, options: { ...synced, syncKind: false } }, 'left', configmaps).right).toBe(right);
    expect(pickKind({ left: deploy, right: {}, options: synced }, 'left', configmaps).right).toEqual({});
    // Clearing the kind clears it on both sides.
    expect(pickKind({ left: deploy, right, options: synced }, 'right', null)).toEqual({ left: { ctx: 'kind-a' }, right: { ctx: 'kind-b' } });
  });

  it('starts a side that just got its cluster on the other side’s kind and namespace', () => {
    expect(adoptKind({ ctx: 'kind-b' }, deploy, true)).toEqual({ ctx: 'kind-b', group: 'apps', version: 'v1', plural: 'deployments', namespace: 'shop' });
    expect(adoptKind({ ctx: 'kind-b' }, deploy, false)).toEqual({ ctx: 'kind-b' });
    expect(adoptKind({ ctx: 'kind-b', group: '', version: 'v1', plural: 'pods' }, deploy, true).plural).toBe('pods');
  });

  it('compares kinds by group, version and plural', () => {
    expect(sameKind(deploy, { ...deploy, ctx: 'kind-b', name: 'other' })).toBe(true);
    expect(sameKind(deploy, { ...deploy, version: 'v2' })).toBe(false);
    expect(sameKind({}, {})).toBe(false);
    expect(withKind({ ctx: 'kind-a', name: 'web' }, null)).toEqual({ ctx: 'kind-a' });
  });
});

describe('defaultRightSide', () => {
  it('prefers another selected cluster, then any connected one', () => {
    expect(defaultRightSide(deploy, { selected: ['kind-a', 'kind-b'], active: ['kind-a', 'kind-c'] })).toEqual({ ...deploy, ctx: 'kind-b' });
    expect(defaultRightSide(deploy, { selected: ['kind-a'], active: ['kind-a', 'kind-c'] })).toEqual({ ...deploy, ctx: 'kind-c' });
  });

  it('stays in the cluster and leaves the name to pick when there is no other', () => {
    expect(defaultRightSide(deploy, { selected: ['kind-a'], active: ['kind-a'] })).toEqual({ ctx: 'kind-a', group: 'apps', version: 'v1', plural: 'deployments', namespace: 'shop' });
  });
});

describe('diff helpers', () => {
  const obj = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'cfg', namespace: 'shop', uid: 'u1', resourceVersion: '7', labels: { app: 'web' } },
    data: { LOG_LEVEL: 'info' },
    status: { observed: true },
  } as unknown as KubeObject;

  it('scopes to the payload for spec/data only', () => {
    expect(diffView(obj, { normalize: true, specOnly: true })).toEqual({ data: { LOG_LEVEL: 'info' } });
  });

  it('normalizes or keeps the whole object otherwise', () => {
    expect(diffView(obj, { normalize: true, specOnly: false })).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'cfg', namespace: 'shop', labels: { app: 'web' } },
      data: { LOG_LEVEL: 'info' },
    });
    expect(diffView(obj, { normalize: false, specOnly: false })).toBe(obj);
  });

  it('knows when a side names one object', () => {
    expect(sideComplete(deploy, true)).toBe(true);
    expect(sideComplete({ ...deploy, namespace: undefined }, true)).toBe(false);
    expect(sideComplete({ ctx: 'kind-a', group: '', version: 'v1', plural: 'nodes', name: 'n1' }, false)).toBe(true);
    expect(sideComplete({ ...deploy, name: undefined }, true)).toBe(false);
  });

  it('labels a side for titles', () => {
    expect(sideLabel(deploy, 'Deployment')).toBe('kind-a · Deployment shop/web');
    expect(sideLabel({ ctx: 'kind-a' })).toBe('kind-a');
  });
});
