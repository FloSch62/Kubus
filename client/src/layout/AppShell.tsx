import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import { useLocation, useNavigate } from 'react-router';
import { TopBar } from './TopBar.js';
import { NavDrawer } from './NavDrawer.js';
import { TabsBar } from './TabsBar.js';
import { TabPanes } from './TabPanes.js';
import { BottomDock } from './BottomDock.js';
import { useDockStore } from '../state/dock.js';
import { useDetailStore } from '../state/detail.js';
import { useTabsStore } from '../state/tabs.js';

// Lazy so the drawer's heavy deps (js-yaml, editors, charts) stay out of the
// first paint; list pages pull the same module as a dependency anyway.
const ResourceDetailDrawer = lazy(() => import('../components/ResourceDetailDrawer.js').then((m) => ({ default: m.ResourceDetailDrawer })));

export function AppShell() {
  const dockOpen = useDockStore((s) => s.open);
  const dockHeight = useDockStore((s) => s.height);
  const maximized = useDockStore((s) => s.maximized);
  const sel = useDetailStore((s) => s.stack.at(-1));
  const hasParent = useDetailStore((s) => s.stack.length > 1);
  const back = useDetailStore((s) => s.back);
  const closeDetail = useDetailStore((s) => s.close);
  // Mounted on first open, kept mounted after so close animations still play.
  const [drawerMounted, setDrawerMounted] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const detailIsEmbedded = location.pathname.startsWith('/r/');
  if (!drawerMounted && sel && !detailIsEmbedded) setDrawerMounted(true);

  // Closing the drawer via X/Escape/backdrop also drops the ?sel deep link
  // from the current tab's URL, so the tab doesn't reopen the drawer on its
  // next activation. Done here (the explicit user action) rather than by
  // watching drawer-state transitions, which races with tab switches.
  const searchRef = useRef({ pathname: location.pathname, search: location.search });
  searchRef.current = { pathname: location.pathname, search: location.search };
  const handleDrawerClose = useCallback(() => {
    closeDetail();
    const { pathname, search } = searchRef.current;
    const params = new URLSearchParams(search);
    if (params.has('sel')) {
      params.delete('sel');
      void navigate({ pathname, search: params.toString() }, { replace: true });
    }
  }, [closeDetail, navigate]);

  // Cmd/Ctrl+W closes the focused dock tab (logs/terminal), then the active
  // page tab, and only closes the window once a single page tab remains.
  useEffect(() => {
    const desktop = window.kubusDesktop;
    if (!desktop?.onCloseTab) return;
    return desktop.onCloseTab(() => {
      const dock = useDockStore.getState();
      if (dock.open && dock.activeId) {
        dock.closeTab(dock.activeId);
        return;
      }
      const pages = useTabsStore.getState();
      if (pages.tabs.length > 1 && pages.activeId) {
        pages.closeTab(pages.activeId);
        const next = useTabsStore.getState();
        const active = next.tabs.find((t) => t.id === next.activeId);
        if (active) void navigate(active.path);
        return;
      }
      desktop.closeWindow();
    });
  }, [navigate]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <TopBar />
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <NavDrawer />
        <Box component="main" sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TabsBar />
          <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <TabPanes />
          </Box>
          <Box ref={dockRef} style={{ height: dockOpen ? (maximized ? '100%' : dockHeight) : 0 }} sx={{ flexShrink: 0, transition: 'height 120ms ease' }}>
            <BottomDock containerRef={dockRef} />
          </Box>
        </Box>
      </Box>
      {drawerMounted && (
        <Suspense fallback={null}>
          <ResourceDetailDrawer sel={detailIsEmbedded ? undefined : sel} onClose={handleDrawerClose} onBack={hasParent ? back : undefined} />
        </Suspense>
      )}
    </Box>
  );
}
