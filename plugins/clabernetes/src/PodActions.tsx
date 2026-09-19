import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Snackbar from '@mui/material/Snackbar';
import TerminalIcon from '@mui/icons-material/Terminal';
import SubjectIcon from '@mui/icons-material/Subject';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { client } from './bridge.js';
import { ref } from './model.js';
import type { ContainerTarget } from './runtime.js';

export function PodActions({
  targets,
  label,
  compact = false,
  loading = false,
  showShell = true,
}: {
  targets: ContainerTarget[];
  label: string;
  compact?: boolean;
  loading?: boolean;
  showShell?: boolean;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const primary = targets.find((t) => !t.helper);
  const run = async (kind: 'shell' | 'logs', target: ContainerTarget) => {
    setMenu(null);
    setPending(true);
    setError('');
    try {
      await (kind === 'shell' ? client.openTerminal : client.openLogs)({ ...ref(target.pod), container: target.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  const shellHint =
    loading && !primary
      ? 'Loading device Pod…'
      : !primary
        ? 'No device Pod yet'
        : !primary.running
          ? `${primary.state}: shell needs a running device container`
          : `Shell · ${label}`;
  const logsHint = !primary ? (loading ? 'Loading device Pod…' : 'No device Pod yet') : `${primary.role} logs · ${label}`;
  return (
    <>
      <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
        {showShell && (
          <Tooltip title={shellHint}>
            <Box component="span">
              {compact ? (
                <IconButton
                  size="small"
                  aria-label={`Shell ${label}`}
                  disabled={pending || !primary?.running}
                  onClick={() => primary && void run('shell', primary)}
                >
                  <TerminalIcon sx={{ fontSize: 18 }} />
                </IconButton>
              ) : (
                <Button
                  variant="outlined"
                  startIcon={<TerminalIcon />}
                  disabled={pending || !primary?.running}
                  onClick={() => primary && void run('shell', primary)}
                >
                  Shell
                </Button>
              )}
            </Box>
          </Tooltip>
        )}
        <Tooltip title={logsHint}>
          <Box component="span">
            {compact ? (
              <IconButton
                size="small"
                aria-label={`Logs ${label}`}
                disabled={pending || !primary}
                onClick={() => primary && void run('logs', primary)}
              >
                <SubjectIcon sx={{ fontSize: 18 }} />
              </IconButton>
            ) : (
              <Button startIcon={<SubjectIcon />} disabled={pending || !primary} onClick={() => primary && void run('logs', primary)}>
                Logs
              </Button>
            )}
          </Box>
        </Tooltip>
        {targets.length > 1 && (
          <Tooltip title="Containers & helper logs">
            <Box component="span">
              <IconButton
                size="small"
                aria-label={`Containers for ${label}`}
                aria-haspopup="menu"
                aria-expanded={!!menu}
                disabled={pending || !targets.length}
                onClick={(e) => setMenu(e.currentTarget)}
              >
                <MoreHorizIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Box>
          </Tooltip>
        )}
      </Stack>
      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)} slotProps={{ paper: { sx: { maxWidth: 430 } } }}>
        {targets.flatMap((t) => [
          <MenuItem key={`${t.name}-logs`} onClick={() => void run('logs', t)}>
            <SubjectIcon fontSize="small" sx={{ mr: 1.5, color: 'text.secondary' }} />
            <ListItemText
              primary={`${t.role} logs`}
              secondary={`${t.name} · ${t.state}`}
              slotProps={{ secondary: { sx: { overflowWrap: 'anywhere', whiteSpace: 'normal', fontSize: 11 } } }}
            />
          </MenuItem>,
          ...(showShell && !t.helper && targets.filter((c) => !c.helper).length > 1
            ? [
                <MenuItem key={`${t.name}-shell`} disabled={!t.running} onClick={() => void run('shell', t)}>
                  <TerminalIcon fontSize="small" sx={{ mr: 1.5 }} />
                  <ListItemText primary={`Shell · ${t.role}`} secondary={t.name} />
                </MenuItem>,
              ]
            : []),
        ])}
      </Menu>
      <Snackbar open={!!error} onClose={() => setError('')}>
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}
