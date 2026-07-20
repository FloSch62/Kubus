import { groupToPath, type FavoriteItem, type ResourceRef } from '@kubus/shared';

/** List-page path for a kind, optionally deep-linking a selection via ?sel=. */
export function kindListPath(
  gvr: { group: string; version: string; plural: string },
  opts?: { sel?: { ctx: string; namespace?: string; name: string } },
): string {
  const params = new URLSearchParams();
  if (opts?.sel) params.set('sel', `${opts.sel.ctx}|${opts.sel.namespace ?? ''}|${opts.sel.name}`);
  const q = params.toString();
  return `/r/${groupToPath(gvr.group)}/${gvr.version}/${gvr.plural}${q ? `?${q}` : ''}`;
}

/** Detail deep link for a resource ref (its list page + ?sel=). */
export function detailPathForRef(ref: ResourceRef): string {
  return kindListPath(ref, { sel: { ctx: ref.ctx, namespace: ref.namespace, name: ref.name } });
}

/**
 * Absolute shareable link for an in-app path. The desktop app is served from
 * a random localhost port, so there the link uses the kubus:// protocol the
 * OS hands back to the app; browsers get a plain origin URL.
 */
export function shareLinkForPath(path: string): string {
  return window.kubusDesktop ? `kubus://${path.startsWith('/') ? path.slice(1) : path}` : window.location.origin + path;
}

/**
 * Favorite entry for a resource. The id matches the server's search-result
 * ids so the grid star and the search-palette star toggle the same favorite.
 */
export function favoriteForRef(ref: ResourceRef): FavoriteItem {
  return {
    id: `resource:${ref.ctx}:${ref.group}/${ref.version}/${ref.plural}:${ref.namespace ?? ''}:${ref.name}`,
    title: `${ref.kind}/${ref.name}`,
    subtitle: `${ref.ctx}${ref.namespace ? ` · ${ref.namespace}` : ''}`,
    path: detailPathForRef(ref),
    ref,
  };
}
