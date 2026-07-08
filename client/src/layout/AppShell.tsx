import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import { Outlet } from 'react-router';
import { TopBar } from './TopBar.js';
import { NavDrawer } from './NavDrawer.js';
import { BottomDock } from './BottomDock.js';
import { useDockStore } from '../state/dock.js';
import { useDetailStore } from '../state/detail.js';
import { ResourceDetailDrawer } from '../components/ResourceDetailDrawer.js';

export function AppShell() {
  const dockOpen = useDockStore((s) => s.open);
  const dockHeight = useDockStore((s) => s.height);
  const maximized = useDockStore((s) => s.maximized);
  const stack = useDetailStore((s) => s.stack);
  const back = useDetailStore((s) => s.back);
  const closeDetail = useDetailStore((s) => s.close);
  const dockRef = useRef<HTMLDivElement>(null);

  // Cmd/Ctrl+W closes the focused dock tab (logs/terminal) instead of the whole
  // window; when nothing is docked it falls back to closing the window.
  useEffect(() => {
    const desktop = window.kubusDesktop;
    if (!desktop?.onCloseTab) return;
    return desktop.onCloseTab(() => {
      const dock = useDockStore.getState();
      if (dock.open && dock.activeId) dock.closeTab(dock.activeId);
      else desktop.closeWindow();
    });
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <TopBar />
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <NavDrawer />
        <Box component="main" sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            <Outlet />
          </Box>
          <Box ref={dockRef} style={{ height: dockOpen ? (maximized ? '100%' : dockHeight) : 0 }} sx={{ flexShrink: 0, transition: 'height 120ms ease' }}>
            <BottomDock containerRef={dockRef} />
          </Box>
        </Box>
      </Box>
      <ResourceDetailDrawer sel={stack.at(-1)} onClose={closeDetail} onBack={stack.length > 1 ? back : undefined} />
    </Box>
  );
}
