import type { FavoriteItem, ResourceKindInfo } from '@kubus/shared';

/**
 * Which clusters a favorite belongs to. Two rules decide it:
 *
 * - an explicit scope (set from the favorite's context menu) always wins;
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

/** Group/plural of a `kind:<group>/<version>/<plural>` favorite. */
function favoriteKind(fav: FavoriteItem): { group: string; plural: string } | undefined {
  if (!fav.id.startsWith('kind:')) return undefined;
  const [group, version, plural] = fav.id.slice('kind:'.length).split('/');
  if (group === undefined || !version || !plural) return undefined;
  return { group, plural };
}

/**
 * Contexts whose discovery we can trust. A context that has not answered yet,
 * or answered with an error, tells us nothing — treating it as empty would
 * blank the whole Favorites group while a cluster is unreachable.
 */
function discoveredContexts({ selected, byContext, errors }: FavoriteScopeContext): Array<ResourceKindInfo[]> {
  return selected.filter((ctx) => !errors?.[ctx] && byContext?.[ctx]).map((ctx) => byContext![ctx]!);
}

/**
 * Whether a favorite belongs in the sidebar for the connected clusters.
 * With nothing connected there is no cluster to judge against, so everything
 * stays listed. Version is ignored when matching kinds so a CRD bumping
 * v1alpha1 → v1 does not silently drop the favorite.
 */
export function isFavoriteVisible(fav: FavoriteItem, scope: FavoriteScopeContext): boolean {
  if (scope.selected.length === 0) return true;

  const scopes = favoriteScopes(fav);
  if (scopes.length) return scopes.some((ctx) => scope.selected.includes(ctx));

  const ctx = favoriteContext(fav);
  if (ctx) return scope.selected.includes(ctx);

  const kind = favoriteKind(fav);
  if (!kind) return true;
  const discovered = discoveredContexts(scope);
  if (!discovered.length) return true;
  return discovered.some((resources) => resources.some((r) => r.group === kind.group && r.plural === kind.plural));
}

/** The favorites to list for the connected clusters, in stored order. */
export function visibleFavorites(favorites: FavoriteItem[], scope: FavoriteScopeContext): FavoriteItem[] {
  return favorites.filter((fav) => isFavoriteVisible(fav, scope));
}
