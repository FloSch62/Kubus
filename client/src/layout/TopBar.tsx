import { lazy, memo, Suspense, useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BrightnessAutoOutlinedIcon from '@mui/icons-material/BrightnessAutoOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import SearchIcon from '@mui/icons-material/Search';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { useClustersStore } from '../state/clusters.js';
import { useDockStore } from '../state/dock.js';
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Mounted on first open, kept mounted after so close animations still play.
  const [searchMounted, setSearchMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  if (searchOpen && !searchMounted) setSearchMounted(true);
  if (settingsOpen && !settingsMounted) setSettingsMounted(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
            minHeight: 52,
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
          <Tooltip title="Search (Ctrl+K)">
            <IconButton size="small" onClick={() => setSearchOpen(true)} onMouseEnter={() => void loadSearchDialog()} onFocus={() => void loadSearchDialog()}>
              <SearchIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {dockTabCount > 0 && (
            <Tooltip title={dockOpen ? 'Hide dock' : `Show dock (${dockTabCount} tabs)`}>
              <IconButton size="small" onClick={() => setDockOpen(!dockOpen)} color={dockOpen ? 'primary' : 'default'}>
                <TerminalIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={mode === 'light' ? 'Switch to dark mode' : mode === 'dark' ? 'Follow system theme' : 'Switch to light mode'}>
            <IconButton size="small" onClick={toggleTheme}>
              {mode === 'light' ? <DarkModeOutlinedIcon fontSize="small" /> : mode === 'dark' ? <BrightnessAutoOutlinedIcon fontSize="small" /> : <LightModeOutlinedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Settings">
            <IconButton size="small" onClick={() => setSettingsOpen(true)} onMouseEnter={() => void loadSettingsDialog()} onFocus={() => void loadSettingsDialog()}>
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
    </>
  );
});
