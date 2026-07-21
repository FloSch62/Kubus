import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layout } from '../theme.js';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import { useLocation, useNavigate } from 'react-router';
import { useTabsStore } from '../state/tabs.js';
import { useClustersStore } from '../state/clusters.js';
import { applySavedViewGridState } from '../state/saved-view.js';
import { useApiResourcesForContexts } from '../api/queries.js';
import { tabMeta } from './tab-meta.js';
import { TruncationTooltip } from '../components/truncation.js';

// Electron always starts at '/'; on the first mount we reopen the tab the user
// left active. Module-scoped so StrictMode's double effect doesn't re-restore.
let sessionRestored = false;

export const TabsBar = memo(function TabsBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const selected = useClustersStore((s) => s.selected);
  const { data: apiResources } = useApiResourcesForContexts(selected);
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname + location.search;
  const activeTab = tabs.find((tab) => tab.id === activeId);

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);

  // A background saved-view tab carries its snapshot without touching the
  // visible page. Consume it exactly once when that tab becomes active.
  useLayoutEffect(() => {
    if (!activeId || !activeTab?.pendingSavedView) return;
    applySavedViewGridState(activeTab.path, activeTab.pendingSavedView);
    useTabsStore.getState().clearPendingSavedView(activeId);
  }, [activeId, activeTab?.path, activeTab?.pendingSavedView]);

  // Router → store: the active tab always mirrors the current location, so
  // in-page navigation (filters, detail deep links, drill-downs) is captured.
  useEffect(() => {
    const store = useTabsStore.getState();
    if (!sessionRestored) {
      sessionRestored = true;
      const active = store.tabs.find((t) => t.id === store.activeId);
      if (active && current === '/' && active.path !== '/') {
        void navigate(active.path, { replace: true });
        return;
      }
    }
    store.syncLocation(current);
  }, [current, navigate]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  // Store → router: after any tab mutation, land on the (new) active tab.
  const act = (mutate: () => void) => {
    mutate();
    const s = useTabsStore.getState();
    const active = s.tabs.find((t) => t.id === s.activeId);
    if (active && active.path !== current) void navigate(active.path);
  };

  const metas = useMemo(() => new Map(tabs.map((t) => [t.id, tabMeta(t.path, apiResources?.resources)])), [tabs, apiResources]);
  const closeTab = (id: string) => act(() => useTabsStore.getState().closeTab(id));
  const menuIndex = menu ? tabs.findIndex((t) => t.id === menu.id) : -1;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        height: 35,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: (theme) => theme.palette.sidebar,
      }}
    >
      <Box
        ref={scrollRef}
        role="tablist"
        aria-label="Open pages"
        onWheel={(e) => {
          if (scrollRef.current && e.deltaY) scrollRef.current.scrollLeft += e.deltaY;
        }}
        sx={{ display: 'flex', minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}
      >
        {tabs.map((tab, idx) => {
          const active = tab.id === activeId;
          const meta = metas.get(tab.id)!;
          return (
            <Box
              key={tab.id}
              ref={active ? activeTabRef : undefined}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                dragIndexRef.current = idx;
                setDragId(tab.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const from = dragIndexRef.current;
                if (from !== null && from !== idx) {
                  useTabsStore.getState().moveTab(from, idx);
                  dragIndexRef.current = idx;
                }
              }}
              onDrop={(e) => e.preventDefault()}
              onDragEnd={() => {
                dragIndexRef.current = null;
                setDragId(null);
              }}
              onClick={() => act(() => useTabsStore.getState().setActive(tab.id))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  act(() => useTabsStore.getState().setActive(tab.id));
                  return;
                }
                if (e.key === 'Delete') {
                  e.preventDefault();
                  closeTab(tab.id);
                  // The focused element is gone; keep keyboard flow on the strip.
                  requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
                  return;
                }
                // Roving focus per the ARIA tabs pattern: arrows move focus
                // (with wrap-around), Enter/Space activates.
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
                  e.preventDefault();
                  const els = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
                  const i = els.indexOf(e.currentTarget as HTMLElement);
                  const to =
                    e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + els.length) % els.length;
                  els[to]?.focus();
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(tab.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: tab.id, x: e.clientX, y: e.clientY });
              }}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                pl: 1.25,
                pr: 0.75,
                // Explicit width (not flex-basis) so the shrink-to-fit tablist
                // sizes to n×tabWidth and only squeezes tabs once the bar is full.
                width: layout.tabWidth,
                minWidth: 100,
                flexShrink: 1,
                borderRight: 1,
                borderColor: 'divider',
                cursor: 'pointer',
                userSelect: 'none',
                opacity: dragId === tab.id ? 0.5 : 1,
                ...(active
                  ? { bgcolor: 'background.default', boxShadow: (theme) => `inset 0 2px 0 0 ${theme.palette.primary.main}` }
                  : { color: 'text.secondary', '&:hover': { bgcolor: 'action.hover' } }),
                '&:hover .tab-close, &:focus-within .tab-close': { opacity: 1 },
              }}
            >
              <Box sx={{ display: 'flex', color: 'text.secondary', '& svg': { fontSize: 15 } }}>{meta.icon}</Box>
              <TruncationTooltip text={meta.title}>
                <Typography variant="body2" noWrap sx={{ flex: 1, fontSize: 12.5 }}>
                  {meta.title}
                </Typography>
              </TruncationTooltip>
              <IconButton
                className="tab-close"
                size="small"
                aria-label={`Close ${meta.title} tab`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                sx={{ p: 0.25, opacity: active ? 1 : 0, transition: 'opacity 120ms ease' }}
              >
                <CloseIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </Box>
          );
        })}
      </Box>
      <Tooltip title="New tab">
        <IconButton
          size="small"
          aria-label="New tab"
          onClick={() => act(() => useTabsStore.getState().openTab('/'))}
          sx={{ alignSelf: 'center', mx: 0.5, p: 0.5 }}
        >
          <AddIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <Box sx={{ flex: 1 }} onDoubleClick={() => act(() => useTabsStore.getState().openTab('/'))} />
      <Menu
        open={!!menu}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
      >
        <MenuItem
          dense
          onClick={() => {
            if (menu) act(() => useTabsStore.getState().duplicateTab(menu.id));
            setMenu(null);
          }}
        >
          Duplicate
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            if (menu) closeTab(menu.id);
            setMenu(null);
          }}
        >
          Close
        </MenuItem>
        <MenuItem
          dense
          disabled={tabs.length < 2}
          onClick={() => {
            if (menu) act(() => useTabsStore.getState().closeOthers(menu.id));
            setMenu(null);
          }}
        >
          Close others
        </MenuItem>
        <MenuItem
          dense
          disabled={menuIndex < 0 || menuIndex >= tabs.length - 1}
          onClick={() => {
            if (menu) act(() => useTabsStore.getState().closeRight(menu.id));
            setMenu(null);
          }}
        >
          Close to the right
        </MenuItem>
      </Menu>
    </Box>
  );
});
