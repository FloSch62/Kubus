import { lazy, memo, Suspense, useState } from 'react';
import { layout } from '../theme.js';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import MenuIcon from '@mui/icons-material/Menu';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BrightnessAutoOutlinedIcon from '@mui/icons-material/BrightnessAutoOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import SearchIcon from '@mui/icons-material/Search';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { useClustersStore } from '../state/clusters.js';
import { useDockStore } from '../state/dock.js';
import { useUiStore } from '../state/ui.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { toggleNavRail } from '../shortcuts.js';
import { ShortcutHelpDialog } from '../components/ShortcutHelpDialog.js';
import { ClusterSwitcher } from './ClusterSwitcher.js';
import { NamespaceFilter } from './NamespaceFilter.js';

// Both dialogs open only on user action; lazy keeps them (and the cluster
// dialogs' js-yaml dependency) out of the first paint.
const loadSearchDialog = () => import('./SearchDialog.js');
const loadSettingsDialog = () => import('../components/settings/SettingsDialog.js');
const SearchDialog = lazy(() => loadSearchDialog().then((m) => ({ default: m.SearchDialog })));
const SettingsDialog = lazy(() => loadSettingsDialog().then((m) => ({ default: m.SettingsDialog })));

export const TopBar = memo(function TopBar() {
  const mode = useClustersStore((s) => s.themeMode);
  const toggleTheme = useClustersStore((s) => s.toggleTheme);
  const dockOpen = useDockStore((s) => s.open);
  const dockTabCount = useDockStore((s) => s.tabs.length);
  const setDockOpen = useDockStore((s) => s.setOpen);
  // Dialog open state lives in the ui store: the global shortcuts and the
  // command palette drive the same dialogs.
  const searchOpen = useUiStore((s) => s.searchOpen);
  const setSearchOpen = useUiStore((s) => s.setSearchOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen);
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
  // Mounted on first open, kept mounted after so close animations still play.
  const [searchMounted, setSearchMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  if (searchOpen && !searchMounted) setSearchMounted(true);
  if (settingsOpen && !settingsMounted) setSettingsMounted(true);

  return (
    <>
      <AppBar position="static" color="transparent" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        {/* In the desktop app the window is frameless and this toolbar doubles as
            the titlebar: it is a drag region, and the env(titlebar-area-*) vars
            reserve space for the native window controls (traffic lights on the
            left on macOS, min/max/close on the right on Windows/Linux). In a
            regular browser the env() fallbacks make all of this a no-op. */}
        <Toolbar
          variant="dense"
          sx={{
            gap: 1.5,
            minHeight: layout.topBarHeight,
            WebkitAppRegion: 'drag',
            // double the specificity: MUI's responsive gutter rule wins otherwise
            '&&': {
              pl: 'calc(env(titlebar-area-x, 0px) + 16px)',
              pr: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 16px)',
            },
            '& button, & input, & a, & [role="button"], & [role="combobox"]': {
              WebkitAppRegion: 'no-drag',
            },
          }}
        >
          <Tooltip title={`Toggle navigation (${HOTKEY_MOD_LABEL}B)`}>
            <IconButton size="small" aria-label="Toggle navigation" onClick={toggleNavRail} sx={{ mr: 0.5 }}>
              <MenuIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Stack direction="row" spacing={1} sx={{ mr: 1.5, alignItems: 'center' }}>
            <Box
              component="img"
              src="/kubus.svg"
              alt=""
              aria-hidden
              sx={{
                width: 30,
                height: 34,
                display: 'block',
                objectFit: 'contain',
              }}
            />
            <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0 }}>
              Kubus
            </Typography>
          </Stack>
          <ClusterSwitcher />
          <NamespaceFilter />
          <Box sx={{ flex: 1 }} />
          <Tooltip title={`Search (${HOTKEY_MOD_LABEL}K)`}>
            <IconButton size="small" aria-label="Search" onClick={() => setSearchOpen(true)} onMouseEnter={() => void loadSearchDialog()} onFocus={() => void loadSearchDialog()}>
              <SearchIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {dockTabCount > 0 && (
            <Tooltip title={dockOpen ? `Hide dock (${HOTKEY_MOD_LABEL}J)` : `Show dock — ${dockTabCount} tabs (${HOTKEY_MOD_LABEL}J)`}>
              <IconButton size="small" aria-label={dockOpen ? 'Hide dock' : 'Show dock'} onClick={() => setDockOpen(!dockOpen)} color={dockOpen ? 'primary' : 'default'}>
                <TerminalIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Keyboard shortcuts (?)">
            <IconButton size="small" aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
              <KeyboardOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={mode === 'light' ? 'Switch to dark mode' : mode === 'dark' ? 'Follow system theme' : 'Switch to light mode'}>
            <IconButton size="small" aria-label="Toggle theme" onClick={toggleTheme}>
              {mode === 'light' ? <DarkModeOutlinedIcon fontSize="small" /> : mode === 'dark' ? <BrightnessAutoOutlinedIcon fontSize="small" /> : <LightModeOutlinedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title={`Settings (${HOTKEY_MOD_LABEL},)`}>
            <IconButton size="small" aria-label="Settings" onClick={() => setSettingsOpen(true)} onMouseEnter={() => void loadSettingsDialog()} onFocus={() => void loadSettingsDialog()}>
              <SettingsOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      {searchMounted && (
        <Suspense fallback={null}>
          <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}
      {settingsMounted && (
        <Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      <ShortcutHelpDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </>
  );
});
