import { describe, expect, it } from 'vitest';
import type { FavoriteItem, ResourceKindInfo } from '@kubus/shared';
import { favoriteScopes, isFavoriteVisible, resolveFavorites } from '../../../client/src/favorite-scope';

const kind = (group: string, plural: string, version = 'v1'): ResourceKindInfo => ({
  group,
  version,
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

const edaDiscovery = {
  eda: [kind('', 'pods'), kind('topo.eda.nokia.com', 'topolinks', 'v1alpha1')],
  c9s: [kind('', 'pods')],
};

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

  it('keeps kinds listed when only some connected clusters reported', () => {
    // c9s does not serve the CRD, but eda failed — it may well serve it.
    expect(isFavoriteVisible(topolinks, { selected: ['c9s', 'eda'], byContext: edaDiscovery, errors: { eda: 'unreachable' } })).toBe(true);
    // Same with eda's discovery still in flight.
    expect(isFavoriteVisible(topolinks, { selected: ['c9s', 'eda'], byContext: { c9s: edaDiscovery.c9s } })).toBe(true);
    // Both answered and neither serves it — now it can go.
    expect(isFavoriteVisible(topolinks, { selected: ['c9s', 'prod'], byContext: { c9s: [], prod: [] } })).toBe(false);
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
    expect(resolveFavorites([topolinks, pods, category], { selected: ['c9s'], byContext: edaDiscovery }).map((f) => f.id)).toEqual([
      pods.id,
      category.id,
    ]);
  });

  it('repoints a kind favorite at the served version', () => {
    // The CRD moved v1alpha1 → v1: the favorite survives, but its link has to
    // follow, since the list page queries whatever version the path names.
    const upgraded = { eda: [kind('topo.eda.nokia.com', 'topolinks', 'v1'), kind('topo.eda.nokia.com', 'topolinks', 'v1beta1')] };
    const [resolved] = resolveFavorites([topolinks], { selected: ['eda'], byContext: upgraded });
    expect(resolved?.path).toBe('/r/topo.eda.nokia.com/v1/topolinks');
    expect(resolved?.id).toBe(topolinks.id);
  });

  it('leaves links alone when the stored version is still served or unknown', () => {
    expect(resolveFavorites([topolinks], { selected: ['eda'], byContext: edaDiscovery })[0]?.path).toBe(topolinks.path);
    expect(resolveFavorites([topolinks], { selected: ['eda'] })[0]?.path).toBe(topolinks.path);
    expect(resolveFavorites([pods, category, object], { selected: ['eda'], byContext: edaDiscovery }).map((f) => f.path)).toEqual([
      pods.path,
      category.path,
      object.path,
    ]);
  });
});
