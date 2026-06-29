import { useEffect, useState } from 'react';
import { AppBar, Box, IconButton, Stack, Toolbar, Tooltip, Typography } from '@mui/material';
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
import { SearchDialog } from './SearchDialog.js';
import { SettingsDialog } from '../components/settings/SettingsDialog.js';

export function TopBar() {
  const mode = useClustersStore((s) => s.themeMode);
  const toggleTheme = useClustersStore((s) => s.toggleTheme);
  const dock = useDockStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mr: 1.5 }}>
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
            <IconButton size="small" onClick={() => setSearchOpen(true)}>
              <SearchIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {dock.tabs.length > 0 && (
            <Tooltip title={dock.open ? 'Hide dock' : `Show dock (${dock.tabs.length} tabs)`}>
              <IconButton size="small" onClick={() => dock.setOpen(!dock.open)} color={dock.open ? 'primary' : 'default'}>
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
            <IconButton size="small" onClick={() => setSettingsOpen(true)}>
              <SettingsOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
