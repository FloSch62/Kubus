import { memo, useContext, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import { UNSAFE_LocationContext, parsePath } from 'react-router';
import { PageRoutes } from '../router.js';
import { PaneActiveContext } from './pane-context.js';
import { useTabsStore } from '../state/tabs.js';

type LocationCtx = React.ContextType<typeof UNSAFE_LocationContext>;

function frozenCtx(path: string, id: string): LocationCtx {
  const parsed = parsePath(path);
  return {
    location: { pathname: parsed.pathname ?? '/', search: parsed.search ?? '', hash: parsed.hash ?? '', state: null, key: id },
    navigationType: 'POP' as LocationCtx['navigationType'],
  };
}

/**
 * Location context for one pane. Hidden panes see a frozen location (their
 * tab's path), so global navigation never re-renders or misroutes them. The
 * provided object keeps its identity as long as the URL content is unchanged:
 * revealing a tab at the URL it already shows must not re-render every
 * location consumer in it. location.key/state are deliberately ignored in the
 * comparison — nothing in the app consumes them.
 */
function useStableLocationCtx(active: boolean, path: string, id: string): LocationCtx {
  const parent = useContext(UNSAFE_LocationContext);
  const ref = useRef<LocationCtx | null>(null);
  const wasActiveRef = useRef(false);
  ref.current ??= frozenCtx(path, id);
  if (active) {
    const prev = ref.current.location;
    const live = parent.location;
    const differs = prev.pathname !== live.pathname || prev.search !== live.search || prev.hash !== live.hash;
    // Adopt the live location for in-tab navigation (pane was already active)
    // or once the pending navigation has landed on this tab's URL. During the
    // urgent phase of a tab switch (react-router wraps navigate() in a
    // transition, so activation commits first) the live location still points
    // at the previous tab and must not leak into this pane.
    const landed = live.pathname + live.search === path;
    if (differs && (wasActiveRef.current || landed)) ref.current = parent;
  }
  wasActiveRef.current = active;
  return ref.current;
}

/**
 * One always-live pane per tab, VS Code style: hidden panes stay mounted and
 * rendering (watches keep their rows current) and are hidden with
 * `visibility: hidden`, which preserves layout — so switching tabs is a
 * paint-only operation, with no re-render, relayout, or refetch.
 */
const TabPane = memo(function TabPane({ id, path, active }: { id: string; path: string; active: boolean }) {
  const value = useStableLocationCtx(active, path, id);
  // Children are memoized on the location value: the active flip must not
  // recreate the JSX, or React reconciles the entire page subtree per switch.
  const children = useMemo(
    () => (
      <UNSAFE_LocationContext.Provider value={value}>
        <Box sx={{ position: 'absolute', inset: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <PageRoutes />
        </Box>
      </UNSAFE_LocationContext.Provider>
    ),
    [value],
  );
  return (
    <Box
      aria-hidden={active ? undefined : true}
      sx={{
        position: 'absolute',
        inset: 0,
        visibility: active ? 'visible' : 'hidden',
        // visibility is overridable by descendants: DataGrid re-shows a sorted
        // column's sort arrow (`.columnHeader--sorted .iconButtonContainer`),
        // which would paint through the active pane. Pin the whole hidden
        // subtree down; !important outbids MUI's more specific selector.
        ...(active ? null : { '& *': { visibility: 'hidden !important' } }),
      }}
    >
      <PaneActiveContext.Provider value={active}>{children}</PaneActiveContext.Provider>
    </Box>
  );
});

export function TabPanes() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  return (
    <>
      {tabs.map((tab) => (
        <TabPane key={tab.id} id={tab.id} path={tab.path} active={tab.id === activeId} />
      ))}
    </>
  );
}
