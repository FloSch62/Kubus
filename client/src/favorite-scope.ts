import type { FavoriteItem, ResourceKindInfo } from '@kubus/shared';
import { preferredKind } from './kind-versions.js';
import { kindListPath } from './resource-links.js';

/**
 * Which clusters a favorite belongs to. Two rules decide it:
 *
 * - an explicit scope (set from the favorite's menu) always wins;
 * - otherwise relevance is inferred — a kind favorite only makes sense while a
 *   connected cluster serves that kind, and a favorited object only while its
 *   own context is connected.
 *
 * Inference is what keeps one cluster's CRDs out of another's sidebar without
 * any setup; the explicit scope covers what discovery cannot tell (a builtin
 * kind or a page you only care about on one cluster).
 */
export interface FavoriteScopeContext {
  /** Contexts currently connected. */
  selected: string[];
  /** Discovered kinds per context; a context missing here has not reported yet. */
  byContext?: Record<string, ResourceKindInfo[]>;
  /** Contexts whose discovery failed — unknown, rather than "serves nothing". */
  errors?: Record<string, string>;
}

/** Contexts a favorite is explicitly pinned to; empty means all clusters. */
export function favoriteScopes(fav: FavoriteItem): string[] {
  return fav.scopes ?? [];
}

/** The context a favorited object lives in, for favorites that point at one. */
export function favoriteContext(fav: FavoriteItem): string | undefined {
  return fav.ref?.ctx;
}

/** GVR of a `kind:<group>/<version>/<plural>` favorite. */
function favoriteKind(fav: FavoriteItem): { group: string; version: string; plural: string } | undefined {
  if (!fav.id.startsWith('kind:')) return undefined;
  const [group, version, plural] = fav.id.slice('kind:'.length).split('/');
  if (group === undefined || !version || !plural) return undefined;
  return { group, version, plural };
}

/**
 * The kinds every connected cluster serves, or null while any of them is
 * unknown. A context that has not answered yet, or answered with an error,
 * tells us nothing — concluding "no cluster serves this" from a partial
 * picture would hide favorites that belong to the cluster we cannot see.
 */
function discoveredKinds({ selected, byContext, errors }: FavoriteScopeContext): ResourceKindInfo[] | null {
  const known = selected.filter((ctx) => !errors?.[ctx] && byContext?.[ctx]);
  if (known.length !== selected.length) return null;
  return known.flatMap((ctx) => byContext![ctx]!);
}

/**
 * Whether a favorite belongs in the sidebar for the connected clusters.
 * With nothing connected there is no cluster to judge against, so everything
 * stays listed. Version is ignored when matching kinds so a CRD bumping
 * v1alpha1 → v1 does not silently drop the favorite; `resolveFavorites` then
 * repoints its link at the served version.
 */
export function isFavoriteVisible(fav: FavoriteItem, scope: FavoriteScopeContext): boolean {
  if (scope.selected.length === 0) return true;

  const scopes = favoriteScopes(fav);
  if (scopes.length) return scopes.some((ctx) => scope.selected.includes(ctx));

  const ctx = favoriteContext(fav);
  if (ctx) return scope.selected.includes(ctx);

  const kind = favoriteKind(fav);
  if (!kind) return true;
  const discovered = discoveredKinds(scope);
  if (!discovered) return true;
  return discovered.some((r) => r.group === kind.group && r.plural === kind.plural);
}

/**
 * The favorites to list for the connected clusters, in stored order, each with
 * its link pointing at a version the clusters actually serve. Kind favorites
 * store the version they were starred at, and the list page queries whatever
 * the path names, so a favorite kept across a CRD version bump has to be
 * repointed or it opens a version that no longer exists.
 */
export function resolveFavorites(favorites: FavoriteItem[], scope: FavoriteScopeContext): FavoriteItem[] {
  const discovered = discoveredKinds(scope);
  return favorites
    .filter((fav) => isFavoriteVisible(fav, scope))
    .map((fav) => {
      if (!discovered || !fav.path) return fav;
      const kind = favoriteKind(fav);
      if (!kind) return fav;
      if (discovered.some((r) => r.group === kind.group && r.version === kind.version && r.plural === kind.plural)) return fav;
      const served = preferredKind(kind.group, kind.plural, discovered);
      return served ? { ...fav, path: kindListPath(served) } : fav;
    });
}
