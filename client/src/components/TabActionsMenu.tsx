import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useDockStore, isShellTab } from '../state/dock.js';
import type { DockTab } from '../state/dock.js';
import { useTabsStore, type PageTab } from '../state/tabs.js';
import { openTabInNewWindow, moveTabToNewWindow, type TabSurface } from '../tab-window-actions.js';
import { showToast } from '../state/toast.js';

export interface TabMenuState {
  surface: TabSurface;
  id: string;
  title: string;
  x: number;
  y: number;
}

const TAB_FLAG_COLORS = ['#ef5350', '#ff9800', '#fdd835', '#66bb6a', '#42a5f5', '#7e57c2'] as const;

export function TabActionsMenu({
  menu,
  onClose,
  afterPageMutation,
}: {
  menu: TabMenuState | null;
  onClose: () => void;
  afterPageMutation?: () => void;
}) {
  const pageTabs = useTabsStore((state) => state.tabs);
  const dockTabs = useDockStore((state) => state.tabs);
  const [renaming, setRenaming] = useState<{ surface: TabSurface; id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tabs: Array<PageTab | DockTab> = menu?.surface === 'dock' ? dockTabs : pageTabs;
  const tab = tabs.find((candidate) => candidate.id === menu?.id);
  const index = tab ? tabs.indexOf(tab) : -1;
  const closeableOthers = tabs.some((candidate) => candidate.id !== menu?.id && !candidate.pinned);
  const closeableRight = index >= 0 && tabs.slice(index + 1).some((candidate) => !candidate.pinned);
  const terminal = !!tab && 'kind' in tab && isShellTab(tab);

  useEffect(() => {
    if (!renaming) return;
    const frame = requestAnimationFrame(() => renameInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [renaming]);

  const run = (action: () => void, pageMutation = false) => {
    action();
    onClose();
    if (pageMutation) afterPageMutation?.();
  };

  const openRename = () => {
    if (!menu) return;
    setRenaming({ surface: menu.surface, id: menu.id, title: menu.title });
    setRenameValue(menu.title);
    onClose();
  };

  const commitRename = () => {
    if (!renaming || !renameValue.trim()) return;
    if (renaming.surface === 'page') useTabsStore.getState().renameTab(renaming.id, renameValue);
    else useDockStore.getState().renameTab(renaming.id, renameValue);
    setRenaming(null);
  };

  return (
    <>
      <Menu
        open={!!menu && !!tab}
        onClose={onClose}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
      >
        <MenuItem onClick={openRename}>
          <ListItemIcon><DriveFileRenameOutlineIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Rename tab</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (!menu || !tab) return;
            run(() => {
              if (menu.surface === 'page') useTabsStore.getState().setPinned(menu.id, !tab.pinned);
              else useDockStore.getState().setPinned(menu.id, !tab.pinned);
            });
          }}
        >
          <ListItemIcon>
            <PushPinOutlinedIcon fontSize="small" sx={{ transform: tab?.pinned ? 'rotate(45deg)' : undefined }} />
          </ListItemIcon>
          <ListItemText>{tab?.pinned ? 'Unpin tab' : 'Pin tab'}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (!menu) return;
            run(() => {
              if (menu.surface === 'page') useTabsStore.getState().duplicateTab(menu.id);
              else useDockStore.getState().duplicateTab(menu.id);
            }, menu.surface === 'page');
          }}
        >
          <ListItemIcon><ContentCopyIcon fontSize="small" /></ListItemIcon>
          <ListItemText>{menu?.surface === 'dock' && terminal ? 'Duplicate (new session)' : 'Duplicate tab'}</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            if (!menu) return;
            if (!openTabInNewWindow(menu.surface, menu.id, menu.title)) {
              showToast('warning', 'The browser blocked the new window. Allow pop-ups for Kubus and try again.');
            }
            onClose();
          }}
        >
          <ListItemIcon><OpenInNewOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Open in new window</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (!menu) return;
            if (!moveTabToNewWindow(menu.surface, menu.id, menu.title)) {
              showToast('warning', 'The browser blocked the new window. Allow pop-ups for Kubus and try again.');
            }
            onClose();
          }}
        >
          <ListItemIcon><DriveFileMoveOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Move to new window</ListItemText>
        </MenuItem>
        {terminal ? (
          <>
            <Divider />
            <MenuItem onClick={() => run(() => useDockStore.getState().requestTerminalReconnect(menu!.id))}>
              <ListItemIcon><RestartAltIcon fontSize="small" /></ListItemIcon>
              <ListItemText>Reconnect</ListItemText>
            </MenuItem>
          </>
        ) : null}
        <Divider />
        <Box sx={{ px: 2, py: 0.75 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Flag</Typography>
          <Stack direction="row" spacing={0.6}>
            {TAB_FLAG_COLORS.map((color) => (
              <ButtonBase
                key={color}
                aria-label={`Flag tab ${color}`}
                onClick={() => {
                  if (!menu) return;
                  if (menu.surface === 'page') useTabsStore.getState().setColor(menu.id, tab?.color === color ? undefined : color);
                  else useDockStore.getState().setColor(menu.id, tab?.color === color ? undefined : color);
                  onClose();
                }}
                sx={{ width: 20, height: 20, borderRadius: '50%', bgcolor: color, '&:hover': { transform: 'scale(1.12)' } }}
              >
                {tab?.color === color ? <CheckIcon sx={{ fontSize: 14, color: 'rgba(0,0,0,0.72)' }} /> : null}
              </ButtonBase>
            ))}
            <Tooltip title="No flag">
              <ButtonBase
                aria-label="Remove tab flag"
                onClick={() => {
                  if (!menu) return;
                  if (menu.surface === 'page') useTabsStore.getState().setColor(menu.id);
                  else useDockStore.getState().setColor(menu.id);
                  onClose();
                }}
                sx={{ width: 20, height: 20, borderRadius: '50%', border: 1, borderColor: 'divider' }}
              >
                {!tab?.color ? <CheckIcon sx={{ fontSize: 14, color: 'text.disabled' }} /> : null}
              </ButtonBase>
            </Tooltip>
          </Stack>
        </Box>
        <Divider />
        <MenuItem
          onClick={() => {
            if (!menu) return;
            run(() => {
              if (menu.surface === 'page') useTabsStore.getState().closeTab(menu.id);
              else useDockStore.getState().closeTab(menu.id);
            }, menu.surface === 'page');
          }}
        >
          <ListItemIcon><CloseIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Close tab</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={!closeableOthers}
          onClick={() => {
            if (!menu) return;
            run(() => {
              if (menu.surface === 'page') useTabsStore.getState().closeOthers(menu.id);
              else useDockStore.getState().closeOthers(menu.id);
            }, menu.surface === 'page');
          }}
        >
          <ListItemIcon><CloseIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Close other tabs</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={!closeableRight}
          onClick={() => {
            if (!menu) return;
            run(() => {
              if (menu.surface === 'page') useTabsStore.getState().closeRight(menu.id);
              else useDockStore.getState().closeRight(menu.id);
            }, menu.surface === 'page');
          }}
        >
          <ListItemIcon><CloseIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Close tabs to the right</ListItemText>
        </MenuItem>
      </Menu>

      <Dialog open={!!renaming} onClose={() => setRenaming(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Rename tab</DialogTitle>
        <DialogContent>
          <TextField
            inputRef={renameInputRef}
            fullWidth
            label="Tab name"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
            }}
            slotProps={{ htmlInput: { maxLength: 200 } }}
            sx={{ mt: 0.5 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenaming(null)}>Cancel</Button>
          <Button variant="contained" disabled={!renameValue.trim()} onClick={commitRename}>Rename</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
