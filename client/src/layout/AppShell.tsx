import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useLocation, useNavigate } from 'react-router';
import { NAV_OVERLAY_MEDIA_QUERY, useNavUiStore } from '../state/nav-ui.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { GlobalShortcuts } from '../shortcuts.js';
import { TopBar } from './TopBar.js';
import { NavDrawer } from './NavDrawer.js';
import { TabsBar } from './TabsBar.js';
import { TabPanes } from './TabPanes.js';
import { BottomDock } from './BottomDock.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { GoHint } from '../components/GoHint.js';
import { useDockStore } from '../state/dock.js';
import { useDetailStore } from '../state/detail.js';
import { useHelmOperationEvents } from '../api/queries.js';

// Lazy so the drawer's heavy deps (js-yaml, editors, charts) stay out of the
// first paint; list pages pull the same module as a dependency anyway.
const ResourceDetailDrawer = lazy(() => import('../components/ResourceDetailDrawer.js').then((m) => ({ default: m.ResourceDetailDrawer })));

export function AppShell() {
  useHelmOperationEvents();
  const navOverlay = useMediaQuery(NAV_OVERLAY_MEDIA_QUERY);
  const navCollapsed = useUiPrefsStore((s) => s.navCollapsed);
  const navOverlayOpen = useNavUiStore((s) => s.overlayOpen);
  // Stable identity — an inline arrow would defeat NavDrawer's memo.
  const closeNavOverlay = useCallback(() => useNavUiStore.getState().setOverlayOpen(false), []);
  const dockOpen = useDockStore((s) => s.open);
  const dockHeight = useDockStore((s) => s.height);
  const maximized = useDockStore((s) => s.maximized);
  const sel = useDetailStore((s) => s.stack.at(-1));
  const selEmbedded = useDetailStore((s) => s.embedded);
  const hasParent = useDetailStore((s) => s.stack.length > 1);
  const back = useDetailStore((s) => s.back);
  const closeDetail = useDetailStore((s) => s.close);
  // Mounted on first open, kept mounted through a close so the exit animation
  // still plays; fully unmounted shortly after (see the watchdog below).
  const [drawerMounted, setDrawerMounted] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const detailIsEmbedded = location.pathname.startsWith('/r/');
  // Embedded-owned selections never reach the overlay drawer: when leaving a
  // list page toward another page, the selection outlives the route change by
  // one commit, and letting the drawer flash open for that commit interrupts
  // its own transitions — a race that can strand MUI's Modal portal as an
  // invisible click-eating overlay.
  const overlaySel = detailIsEmbedded || selEmbedded ? undefined : sel;
  if (!drawerMounted && overlaySel) setDrawerMounted(true);

  // Watchdog: once the drawer is closed, drop it from the tree after the exit
  // animation. Unmounting destroys the Modal portal outright, so no stuck
  // transition state can outlive a close and keep swallowing input.
  const drawerIdle = drawerMounted && !overlaySel;
  useEffect(() => {
    if (!drawerIdle) return;
    const timer = setTimeout(() => setDrawerMounted(false), 1_000);
    return () => clearTimeout(timer);
  }, [drawerIdle]);

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

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <GlobalShortcuts />
      <GoHint />
      {/* First tab stop: jump keyboard users past the top bar and nav rail. */}
      <ButtonBase
        onClick={() => mainRef.current?.focus()}
        sx={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: (theme) => theme.zIndex.modal + 1,
          px: 1.5,
          py: 1,
          borderRadius: 1,
          border: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          boxShadow: 4,
          typography: 'body2',
          transform: 'translateY(-250%)',
          '&:focus-visible': { transform: 'none' },
        }}
      >
        Skip to content
      </ButtonBase>
      <TopBar />
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <NavDrawer overlay={navOverlay} hidden={navCollapsed} open={navOverlayOpen} onClose={closeNavOverlay} />
        <Box component="main" ref={mainRef} tabIndex={-1} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', outline: 'none' }}>
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
        <ErrorBoundary label="The details panel">
          <Suspense fallback={null}>
            <ResourceDetailDrawer sel={overlaySel} onClose={handleDrawerClose} onBack={hasParent ? back : undefined} />
          </Suspense>
        </ErrorBoundary>
      )}
    </Box>
  );
}
