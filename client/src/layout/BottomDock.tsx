import { useEffect } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import TerminalIcon from '@mui/icons-material/Terminal';
import SubjectIcon from '@mui/icons-material/Subject';
import { clampDockHeight, useDockStore } from '../state/dock.js';
import { TerminalPane } from '../components/TerminalPane.js';
import { LogViewer } from '../components/LogViewer.js';

export function BottomDock({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const tabs = useDockStore((s) => s.tabs);
  const activeId = useDockStore((s) => s.activeId);
  const open = useDockStore((s) => s.open);
  const setActive = useDockStore((s) => s.setActive);
  const closeTab = useDockStore((s) => s.closeTab);
  const setOpen = useDockStore((s) => s.setOpen);
  const setHeight = useDockStore((s) => s.setHeight);
  const maximized = useDockStore((s) => s.maximized);
  const setMaximized = useDockStore((s) => s.setMaximized);

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized, setMaximized]);

  if (!open || tabs.length === 0) return null;

  // Resize by writing the container height directly to the DOM (one write per
  // frame), keeping React out of the drag loop; the store is committed once on
  // mouseup so the rest of the app re-renders a single time.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const startY = e.clientY;
    const startHeight = useDockStore.getState().height;
    let pending = startHeight;
    let frame = 0;
    el.style.transition = 'none';
    const onMove = (ev: MouseEvent) => {
      pending = clampDockHeight(startHeight + (startY - ev.clientY));
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          el.style.height = `${pending}px`;
        });
      }
    };
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame);
      el.style.height = `${pending}px`;
      el.style.transition = '';
      setHeight(pending);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
      {!maximized && (
        <Box
          onMouseDown={startResize}
          sx={{
            height: 6,
            cursor: 'row-resize',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            '&:hover .grip, &:active .grip': { bgcolor: 'primary.main', width: 56 },
          }}
        >
          <Box className="grip" sx={{ width: 36, height: 3, borderRadius: 2, bgcolor: 'divider', transition: 'all 120ms ease' }} />
        </Box>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Tabs value={activeId ?? false} onChange={(_e, v) => setActive(v as string)} variant="scrollable" sx={{ minHeight: 32, flex: 1 }}>
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              value={tab.id}
              sx={{ minHeight: 32, py: 0, textTransform: 'none' }}
              onMouseDown={(e) => {
                // Prevent Chromium's middle-click autoscroll so onAuxClick fires cleanly.
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.id);
              }}
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {tab.kind === 'terminal' || tab.kind === 'node-shell' ? <TerminalIcon sx={{ fontSize: 14 }} /> : <SubjectIcon sx={{ fontSize: 14 }} />}
                  {tab.title}
                  <IconButton
                    component="span"
                    size="small"
                    sx={{ p: 0.25, ml: 0.5 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 13 }} />
                  </IconButton>
                </Box>
              }
            />
          ))}
        </Tabs>
        <Tooltip title={maximized ? 'Restore' : 'Maximize'}>
          <IconButton size="small" onClick={() => setMaximized(!maximized)}>
            {maximized ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Minimize">
          <IconButton size="small" onClick={() => setOpen(false)}>
            <KeyboardArrowDownIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {tabs.map((tab) => (
          <Box key={tab.id} sx={{ position: 'absolute', inset: 0, display: tab.id === activeId ? 'block' : 'none' }}>
            {tab.kind === 'terminal' || tab.kind === 'node-shell' ? <TerminalPane tab={tab} active={tab.id === activeId} /> : <LogViewer tab={tab} />}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
