import { describe, expect, it } from 'vitest';
import type { FavoriteItem, ResourceKindInfo } from '@kubus/shared';
import { favoriteScopes, isFavoriteVisible, visibleFavorites } from '../../../client/src/favorite-scope';

const kind = (group: string, plural: string): ResourceKindInfo => ({
  group,
  version: 'v1',
  kind: plural,
  plural,
  namespaced: true,
  verbs: ['list'],
});

const pods: FavoriteItem = { id: 'kind:/v1/pods', title: 'Pods', path: '/r/core/v1/pods' };
const topolinks: FavoriteItem = { id: 'kind:topo.eda.nokia.com/v1alpha1/topolinks', title: 'TopoLinks', path: '/r/topo.eda.nokia.com/v1alpha1/topolinks' };
const category: FavoriteItem = { id: 'category:Workloads', title: 'Workloads' };
const page: FavoriteItem = { id: 'page:/network', title: 'Network Metrics', path: '/network' };
const object: FavoriteItem = {
  id: 'resource:eda:apps/v1/deployments:default:api',
  title: 'Deployment/api',
  path: '/d/eda/apps/v1/deployments/default/api',
  ref: { ctx: 'eda', group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', name: 'api', namespace: 'default' },
};

const edaDiscovery = { eda: [kind('', 'pods'), kind('topo.eda.nokia.com', 'topolinks')], c9s: [kind('', 'pods')] };

describe('favorite scoping', () => {
  it('reads the explicit scope list', () => {
    expect(favoriteScopes(pods)).toEqual([]);
    expect(favoriteScopes({ ...pods, scopes: ['eda'] })).toEqual(['eda']);
  });

  it('lists everything while no cluster is connected', () => {
    expect(isFavoriteVisible({ ...topolinks, scopes: ['eda'] }, { selected: [] })).toBe(true);
  });

  it('honours an explicit scope over discovery', () => {
    const scoped = { ...pods, scopes: ['eda'] };
    expect(isFavoriteVisible(scoped, { selected: ['eda'], byContext: edaDiscovery })).toBe(true);
    expect(isFavoriteVisible(scoped, { selected: ['c9s'], byContext: edaDiscovery })).toBe(false);
    // Any connected context in the scope is enough with several selected.
    expect(isFavoriteVisible(scoped, { selected: ['c9s', 'eda'], byContext: edaDiscovery })).toBe(true);
  });

  it('infers relevance for kinds from discovery, ignoring the version', () => {
    expect(isFavoriteVisible(topolinks, { selected: ['eda'], byContext: edaDiscovery })).toBe(true);
    expect(isFavoriteVisible(topolinks, { selected: ['c9s'], byContext: edaDiscovery })).toBe(false);
    expect(isFavoriteVisible(pods, { selected: ['c9s'], byContext: edaDiscovery })).toBe(true);
  });

  it('keeps kinds listed while discovery is missing or failed', () => {
    expect(isFavoriteVisible(topolinks, { selected: ['c9s'] })).toBe(true);
    expect(isFavoriteVisible(topolinks, { selected: ['c9s'], byContext: { c9s: [] }, errors: { c9s: 'unreachable' } })).toBe(true);
    expect(isFavoriteVisible(topolinks, { selected: ['c9s'], byContext: { c9s: [] } })).toBe(false);
  });

  it('ties a favorited object to its own context', () => {
    expect(isFavoriteVisible(object, { selected: ['eda'], byContext: edaDiscovery })).toBe(true);
    expect(isFavoriteVisible(object, { selected: ['c9s'], byContext: edaDiscovery })).toBe(false);
  });

  it('leaves categories and pages alone unless scoped', () => {
    expect(isFavoriteVisible(category, { selected: ['c9s'], byContext: edaDiscovery })).toBe(true);
    expect(isFavoriteVisible(page, { selected: ['c9s'], byContext: edaDiscovery })).toBe(true);
    expect(isFavoriteVisible({ ...page, scopes: ['eda'] }, { selected: ['c9s'], byContext: edaDiscovery })).toBe(false);
  });

  it('filters in stored order', () => {
    expect(visibleFavorites([topolinks, pods, category], { selected: ['c9s'], byContext: edaDiscovery }).map((f) => f.id)).toEqual([
      pods.id,
      category.id,
    ]);
  });
});
