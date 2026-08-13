import { memo, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { BottomDock } from './BottomDock.js';
import { useDockStore } from '../state/dock.js';

function closeUtilityWindow(): void {
  if (window.kubusDesktop) window.kubusDesktop.closeWindow();
  else window.close();
}

/** Focused secondary renderer: one compact tab strip and its terminal/log content. */
export const DockWindowShell = memo(function DockWindowShell() {
  const tabCount = useDockStore((state) => state.tabs.length);
  const activeId = useDockStore((state) => state.activeId);
  const activeTitle = useDockStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.title);
  const containerRef = useRef<HTMLDivElement>(null);
  const hadContent = useRef(tabCount > 0);

  useEffect(() => {
    if (tabCount > 0) {
      hadContent.current = true;
      return;
    }
    if (hadContent.current) closeUtilityWindow();
  }, [tabCount]);

  useEffect(() => {
    document.title = activeTitle ? `${activeTitle} — Kubus` : 'Kubus';
  }, [activeTitle]);

  useEffect(() => {
    if (!activeId) return;
    const tab = useDockStore.getState().tabs.find((candidate) => candidate.id === activeId);
    if (tab?.kind === 'terminal' || tab?.kind === 'node-shell') {
      useDockStore.getState().requestTerminalFocus(activeId);
    }
  }, [activeId]);

  useEffect(() => {
    const closeActive = () => {
      const dock = useDockStore.getState();
      if (dock.activeId) dock.closeTab(dock.activeId);
    };
    const cycle = (backwards: boolean) => {
      const dock = useDockStore.getState();
      if (dock.tabs.length < 2) return;
      const index = Math.max(0, dock.tabs.findIndex((tab) => tab.id === dock.activeId));
      dock.setActive(dock.tabs[(index + (backwards ? -1 : 1) + dock.tabs.length) % dock.tabs.length]!.id);
    };
    const offClose = window.kubusDesktop?.onCloseTab(closeActive);
    const offCycle = window.kubusDesktop?.onCycleTab(cycle);
    return () => {
      offClose?.();
      offCycle?.();
    };
  }, []);

  if (tabCount === 0) {
    return (
      <Box
        className="kubus-dock-window-loading"
        sx={{
          height: '100vh',
          display: 'grid',
          placeContent: 'center',
          gap: 1.5,
          justifyItems: 'center',
          bgcolor: 'background.default',
          WebkitAppRegion: 'drag',
        }}
      >
        <CircularProgress size={22} />
        <Typography variant="body2" color="text.secondary">Moving tab…</Typography>
      </Box>
    );
  }

  return (
    <Box ref={containerRef} sx={{ height: '100vh', overflow: 'hidden' }}>
      <BottomDock containerRef={containerRef} standalone />
    </Box>
  );
});
