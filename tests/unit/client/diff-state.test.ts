import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  defaultRightSide,
  diffPath,
  diffView,
  encodeSide,
  parseSide,
  readDiffState,
  sideComplete,
  sideLabel,
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
    const path = diffPath({ left: deploy, right: { ...deploy, ctx: 'kind-b' }, options: { normalize: false, specOnly: true, onlyChanges: true } });
    const state = readDiffState(new URLSearchParams(path.slice('/diff'.length)));
    expect(state).toEqual({
      left: deploy,
      right: { ...deploy, ctx: 'kind-b' },
      options: { normalize: false, specOnly: true, onlyChanges: true },
    });
    expect(readDiffState(new URLSearchParams()).options).toEqual({ normalize: true, specOnly: false, onlyChanges: false });
  });

  it('names a compare tab after what it compares', () => {
    expect(tabMeta(diffPath({ left: deploy, right: { ...deploy, ctx: 'kind-b' } })).title).toBe('Diff: web');
    expect(tabMeta(diffPath({ left: deploy, right: { ...deploy, name: 'api' } })).title).toBe('Diff: web ↔ api');
    expect(tabMeta('/diff').title).toBe('Diff');
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
