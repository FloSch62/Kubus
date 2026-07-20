import { groupToPath } from '@kubus/shared';

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
