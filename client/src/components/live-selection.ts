import type { ClusterRow } from '../api/queries.js';

/**
 * The checked rows as they are now. The grid reports row objects from the
 * moment they were checked and never updates them, so bulk actions reading
 * those would act on stale state: a Deployment at 0 replicas when checked
 * and scaled up since would still look idle to the production guard. Rows
 * are matched by uid against the live list; rows that have gone are dropped.
 * Returns `checked` itself when nothing changed, so memoized consumers stay put.
 */
export function liveSelection(checked: ClusterRow[], live: ClusterRow[]): ClusterRow[] {
  if (!checked.length) return checked;
  const byUid = new Map(live.map((row) => [row.obj.metadata.uid, row]));
  const next = checked.flatMap((row) => {
    const current = byUid.get(row.obj.metadata.uid);
    return current ? [current] : [];
  });
  return next.length === checked.length && next.every((row, i) => row === checked[i]) ? checked : next;
}
