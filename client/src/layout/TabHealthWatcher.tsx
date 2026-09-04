import { useEffect, useMemo, useRef } from 'react';
import { groupFromPath, gvkForResource, type KubeObject, type ResourceKindInfo } from '@kubus/shared';
import { watchClient } from '../api/ws/watch-client.js';
import { isResourceHealthy } from '../smart-filter.js';
import { useTabAttentionStore } from '../state/tab-attention.js';
import type { PageTab } from '../state/tabs.js';

interface WatchedSelection {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespace?: string;
  name: string;
}

/** The object a page tab shows, when its path is a list page with a `?sel=` deep link. */
export function tabSelection(path: string, discovered?: ResourceKindInfo[]): WatchedSelection | undefined {
  const [pathname, search = ''] = path.split('?', 2);
  if (!pathname?.startsWith('/r/')) return undefined;
  const raw = new URLSearchParams(search).get('sel');
  if (!raw) return undefined;
  const [ctx, namespace, name] = raw.split('|');
  if (!ctx || !name) return undefined;
  const [, , pathGroup = 'core', version = '', plural = ''] = pathname.split('/');
  const group = groupFromPath(pathGroup);
  const kind = gvkForResource(group, version, plural)?.kind ?? discovered?.find((r) => r.group === group && r.version === version && r.plural === plural)?.kind;
  if (!kind || !version || !plural) return undefined;
  return { ctx, group, version, plural, kind, namespace: namespace || undefined, name };
}

/**
 * Watches one background tab's object over the shared watch stream (the
 * same wire subscription its hidden list page holds, so it costs nothing
 * extra) and marks the tab when the object goes from healthy to unhealthy
 * while the user is elsewhere. Activating the tab clears the mark.
 */
function TabWatcher({ tab, active, sel }: { tab: PageTab; active: boolean; sel: WatchedSelection }) {
  const mark = useTabAttentionStore((s) => s.mark);
  const clear = useTabAttentionStore((s) => s.clear);
  // Health when the tab was last in front — the baseline a change is judged against.
  const baseline = useRef<boolean | undefined>(undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  const key = `${sel.ctx}|${sel.group}|${sel.version}|${sel.plural}|${sel.namespace ?? ''}|${sel.name}`;

  useEffect(() => {
    if (active) {
      clear(tab.id);
      baseline.current = undefined;
    }
  }, [active, tab.id, clear]);

  useEffect(() => {
    const matches = (obj: KubeObject) => obj.metadata.name === sel.name && (obj.metadata.namespace ?? '') === (sel.namespace ?? '');
    const observe = (obj: KubeObject | undefined, deleted = false) => {
      const healthy = deleted ? false : obj ? isResourceHealthy(sel.kind, obj) : undefined;
      if (healthy === undefined) return;
      if (activeRef.current || baseline.current === undefined) {
        // In front, or first sighting after (re)activation: this is what the user saw.
        baseline.current = healthy;
        return;
      }
      if (baseline.current && !healthy) {
        mark(tab.id, deleted ? `${sel.kind} ${sel.name} was deleted while you were away` : `${sel.kind} ${sel.name} became unhealthy while you were away`);
      } else if (healthy) {
        baseline.current = true;
        clear(tab.id);
      }
    };
    return watchClient.subscribe(
      { ctx: sel.ctx, group: sel.group ? sel.group : 'core', version: sel.version, plural: sel.plural, namespace: undefined },
      {
        onSnapshot: (items) => observe(items.find(matches)),
        onEvents: (events) => {
          for (const ev of events) {
            if (!matches(ev.object)) continue;
            observe(ev.object, ev.type === 'DELETED');
          }
        },
        onStatus: () => {},
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the selection identity
  }, [key, tab.id, mark, clear]);
  return null;
}

/** One watcher per tab that shows a single object. */
export function TabHealthWatchers({ tabs, activeId, discovered }: { tabs: PageTab[]; activeId: string | undefined; discovered?: ResourceKindInfo[] }) {
  const watched = useMemo(() => tabs.flatMap((tab) => {
    const sel = tabSelection(tab.path, discovered);
    return sel ? [{ tab, sel }] : [];
  }), [tabs, discovered]);
  return (
    <>
      {watched.map(({ tab, sel }) => (
        <TabWatcher key={tab.id} tab={tab} active={tab.id === activeId} sel={sel} />
      ))}
    </>
  );
}
