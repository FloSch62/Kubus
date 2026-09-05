import { WindowControls } from './WindowControls.js';
import { memo, useRef, useState } from 'react';
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
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import { clampDockHeight, useDockStore } from '../state/dock.js';
import { TerminalPane } from '../components/TerminalPane.js';
import { LogViewer } from '../components/LogViewer.js';
import { TabActionsMenu, type TabMenuState } from '../components/TabActionsMenu.js';
import { createTabTransferId, finishLocalTabTransfer, receiveTabTransfer, registerTabTransferSource } from '../tab-transfer.js';
import { hasTabTransfer, readTabTransfer, shouldDetachTabDrag, writeTabTransfer } from '../tab-drag.js';
import { detachTabWindow } from '../window-management.js';
import { currentAppWindowContext } from '../window-context.js';

export const BottomDock = memo(function BottomDock({
  containerRef,
  standalone = false,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Fill a focused terminal/log utility window instead of the resizable app dock. */
  standalone?: boolean;
}) {
  const tabs = useDockStore((s) => s.tabs);
  const activeId = useDockStore((s) => s.activeId);
  const open = useDockStore((s) => s.open);
  const setActive = useDockStore((s) => s.setActive);
  const closeTab = useDockStore((s) => s.closeTab);
  const setOpen = useDockStore((s) => s.setOpen);
  const setHeight = useDockStore((s) => s.setHeight);
  const maximized = useDockStore((s) => s.maximized);
  const setMaximized = useDockStore((s) => s.setMaximized);
  const terminalFocusRequest = useDockStore((s) => s.terminalFocusRequest);
  const terminalReconnectRequests = useDockStore((s) => s.terminalReconnectRequests);
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const dragTransferIdRef = useRef<string | null>(null);
  const localDropRef = useRef(false);
  const visible = standalone || open;

  // Escape restores a maximized dock via the global dismiss chain in
  // GlobalShortcuts — guarded there so a focused terminal keeps its Escape.
  // Keep existing tabs mounted while collapsed. In particular, an exec
  // terminal's WebSocket and remote shell must survive hiding the dock.
  if (tabs.length === 0) return null;

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
    <Box
      className="kubus-bottom-dock"
      sx={{
        height: '100%',
        display: 'flex',
        visibility: visible ? 'visible' : 'hidden',
        flexDirection: 'column',
        borderTop: standalone ? 0 : 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      {!standalone && !maximized && (
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
      <Box
        className={standalone ? 'kubus-dock-window-titlebar' : undefined}
        sx={{
          display: 'flex',
          alignItems: 'center',
          minHeight: standalone ? 52 : undefined,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
          '--electrobun-app-region': standalone ? 'drag' : undefined,
          pl: standalone && window.kubusDesktop?.platform === 'darwin' ? '80px' : undefined,
          '& button': { '--electrobun-app-region': 'no-drag' },
        }}
      >
        <Tabs
          value={activeId ?? false}
          onChange={(_e, v) => setActive(v as string)}
          variant="scrollable"
          sx={{ minHeight: standalone ? 52 : 32, flex: 1 }}
        >
          {tabs.map((tab, index) => (
            <Tab
              key={tab.id}
              value={tab.id}
              draggable
              sx={{ minHeight: standalone ? 52 : 32, py: 0, textTransform: 'none' }}
              onDragStart={(event) => {
                const transferId = createTabTransferId();
                registerTabTransferSource(transferId, 'dock', tab.id);
                writeTabTransfer(event.dataTransfer, transferId);
                dragTransferIdRef.current = transferId;
                dragIndexRef.current = index;
                localDropRef.current = false;
                setDragId(tab.id);
              }}
              onDragOver={(event) => {
                if (dragIndexRef.current === null && !hasTabTransfer(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const from = dragIndexRef.current;
                if (from !== null && from !== index) {
                  const state = useDockStore.getState();
                  if (!!state.tabs[from]?.pinned === !!state.tabs[index]?.pinned) {
                    state.moveTab(from, index);
                    dragIndexRef.current = index;
                  }
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const transferId = readTabTransfer(event.dataTransfer);
                if (!transferId) return;
                if (dragIndexRef.current !== null) {
                  localDropRef.current = true;
                  finishLocalTabTransfer(transferId);
                  return;
                }
                void receiveTabTransfer(
                  transferId,
                  tab.id,
                  event.clientX < event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2 ? 'before' : 'after',
                );
              }}
              onDragEnd={(event) => {
                const transferId = dragTransferIdRef.current;
                if (transferId && !localDropRef.current && event.dataTransfer.dropEffect === 'none') {
                  if (window.kubusDesktop || shouldDetachTabDrag(event.nativeEvent)) {
                    void detachTabWindow({
                      kind: 'tab-transfer',
                      surface: 'dock',
                      transferId,
                      title: tab.title,
                      context: currentAppWindowContext(),
                    }).then((detached) => {
                      if (!detached) finishLocalTabTransfer(transferId);
                    });
                  } else {
                    finishLocalTabTransfer(transferId);
                  }
                }
                dragIndexRef.current = null;
                dragTransferIdRef.current = null;
                setDragId(null);
              }}
              onMouseDown={(e) => {
                // Prevent Chromium's middle-click autoscroll so onAuxClick fires cleanly.
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ surface: 'dock', id: tab.id, title: tab.title, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Delete') {
                  e.preventDefault();
                  closeTab(tab.id);
                  return;
                }
                if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setTabMenu({ surface: 'dock', id: tab.id, title: tab.title, x: rect.left + 8, y: rect.bottom - 4 });
              }}
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {tab.kind === 'terminal' || tab.kind === 'node-shell' ? <TerminalIcon sx={{ fontSize: 14 }} /> : <SubjectIcon sx={{ fontSize: 14 }} />}
                  {tab.pinned ? <PushPinOutlinedIcon aria-label="Pinned" sx={{ fontSize: 13, transform: 'rotate(45deg)' }} /> : null}
                  {tab.color ? <Box aria-label="Tab flag" sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: tab.color }} /> : null}
                  {tab.title}
                  <IconButton
                    component="span"
                    size="small"
                    aria-label={`Close ${tab.title}`}
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
              style={{ opacity: dragId === tab.id ? 0.5 : 1 }}
            />
          ))}
        </Tabs>
        {standalone && <WindowControls />}
        {!standalone ? (
          <>
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
          </>
        ) : null}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {tabs.map((tab) => (
          <Box key={tab.id} sx={{ position: 'absolute', inset: 0, display: tab.id === activeId ? 'block' : 'none' }}>
            {tab.kind === 'terminal' || tab.kind === 'node-shell' ? (
              <TerminalPane
                tab={tab}
                active={visible && tab.id === activeId}
                focusRequest={terminalFocusRequest?.tabId === tab.id ? terminalFocusRequest.sequence : 0}
                reconnectRequest={terminalReconnectRequests[tab.id] ?? 0}
              />
            ) : visible ? (
              <LogViewer tab={tab} />
            ) : null}
          </Box>
        ))}
      </Box>
      <TabActionsMenu menu={tabMenu} onClose={() => setTabMenu(null)} />
    </Box>
  );
});
