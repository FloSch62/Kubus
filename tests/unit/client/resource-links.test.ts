import type { ResourceRef } from '@kubus/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detailPathForRef,
  favoriteForRef,
  kindListPath,
  shareLinkForPath,
} from '../../../client/src/resource-links';

const deployRef: ResourceRef = {
  ctx: 'kind-a',
  group: 'apps',
  version: 'v1',
  plural: 'deployments',
  kind: 'Deployment',
  name: 'web',
  namespace: 'prod',
};

const clusterScopedRef: ResourceRef = {
  ctx: 'kind-b',
  group: '',
  version: 'v1',
  plural: 'nodes',
  kind: 'Node',
  name: 'node-1',
};

describe('kindListPath', () => {
  it('builds the list path from the GVR', () => {
    expect(kindListPath({ group: 'apps', version: 'v1', plural: 'deployments' })).toBe('/r/apps/v1/deployments');
  });

  it('maps the core group to its path sentinel', () => {
    expect(kindListPath({ group: '', version: 'v1', plural: 'pods' })).toBe('/r/core/v1/pods');
  });

  it('encodes the selection as a pipe-joined ?sel param', () => {
    const path = kindListPath(
      { group: '', version: 'v1', plural: 'pods' },
      { sel: { ctx: 'kind-a', namespace: 'default', name: 'web-1' } },
    );
    expect(path).toBe('/r/core/v1/pods?sel=kind-a%7Cdefault%7Cweb-1');
  });

  it('leaves the namespace slot empty for cluster-scoped selections', () => {
    const path = kindListPath({ group: '', version: 'v1', plural: 'nodes' }, { sel: { ctx: 'kind-b', name: 'node-1' } });
    expect(path).toBe('/r/core/v1/nodes?sel=kind-b%7C%7Cnode-1');
  });
});

describe('detailPathForRef', () => {
  it('deep-links the ref on its list page', () => {
    expect(detailPathForRef(deployRef)).toBe('/r/apps/v1/deployments?sel=kind-a%7Cprod%7Cweb');
    expect(detailPathForRef(clusterScopedRef)).toBe('/r/core/v1/nodes?sel=kind-b%7C%7Cnode-1');
  });
});

describe('shareLinkForPath', () => {
  const win = window as unknown as { kubusDesktop?: object };

  afterEach(() => {
    delete win.kubusDesktop;
  });

  it('uses the browser origin outside the desktop app', () => {
    expect(shareLinkForPath('/r/apps/v1/deployments')).toBe(`${window.location.origin}/r/apps/v1/deployments`);
  });

  it('uses the kubus:// protocol inside the desktop app', () => {
    win.kubusDesktop = {};
    expect(shareLinkForPath('/r/apps/v1/deployments')).toBe('kubus://r/apps/v1/deployments');
    expect(shareLinkForPath('r/apps/v1/deployments')).toBe('kubus://r/apps/v1/deployments');
  });
});

describe('favoriteForRef', () => {
  it('builds the id, labels and path for a namespaced ref', () => {
    const fav = favoriteForRef(deployRef);
    expect(fav).toEqual({
      id: 'resource:kind-a:apps/v1/deployments:prod:web',
      title: 'Deployment/web',
      subtitle: 'kind-a · prod',
      path: detailPathForRef(deployRef),
      ref: deployRef,
    });
    expect(fav.ref).toBe(deployRef);
  });

  it('omits the namespace slot for cluster-scoped refs', () => {
    const fav = favoriteForRef(clusterScopedRef);
    // the id keeps the raw group (empty for core), unlike the path sentinel
    expect(fav.id).toBe('resource:kind-b:/v1/nodes::node-1');
    expect(fav.subtitle).toBe('kind-b');
  });
});
