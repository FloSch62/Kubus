import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { DesktopUpdateState } from '@kubus/shared';
import { ConfirmDialog } from './ConfirmDialog.js';

export function useDesktopUpdate(): DesktopUpdateState | undefined {
  const [state, setState] = useState<DesktopUpdateState>();
  useEffect(() => {
    const desktop = window.kubusDesktop;
    if (!desktop) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = desktop.onUpdateState((next) => { receivedEvent = true; setState(next); });
    void desktop.getUpdateState().then((next) => {
      if (active && !receivedEvent) setState(next);
    }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);
  return state;
}

export function RestartToUpdate({ compact = false }: { compact?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState(false);
  return <>
    <Button color={compact ? 'inherit' : 'primary'} size={compact ? 'small' : 'medium'} onClick={() => setConfirm(true)}>Restart to update</Button>
    <ConfirmDialog open={confirm} title="Restart Kubus to update?" confirmLabel="Restart to update"
      message="All Kubus windows will close. Save any edits first. Terminals, log streams and port forwards will disconnect."
      onClose={() => setConfirm(false)} onConfirm={() => {
        setConfirm(false);
        setError(false);
        void window.kubusDesktop?.installUpdate().then((accepted) => setError(!accepted)).catch(() => setError(true));
      }} />
    {error && <Alert severity="error">The update could not be started. Try again from Settings → About.</Alert>}
  </>;
}

export function DesktopUpdateControls() {
  const state = useDesktopUpdate();
  const [error, setError] = useState(false);
  const busy = !state || ['checking', 'downloading', 'installing'].includes(state.status);
  if (state?.status === 'disabled') {
    return <Typography variant="body2" color="text.secondary">{
      state.reason === 'store' ? 'Updates are managed by Microsoft Store or your organization.' :
      state.reason === 'package-manager' ? 'Install updates with your Linux package manager or download a newer package from Releases.' :
      state.reason === 'unsupported-architecture' ? 'New macOS releases require Apple Silicon.' :
      'Automatic updates are available in installed desktop releases.'
    }</Typography>;
  }
  return <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
    <Stack direction="row" spacing={1}>
      <Button variant="contained" disabled={busy || state?.status === 'ready'} onClick={() => {
        setError(false);
        void window.kubusDesktop?.checkForUpdates().catch(() => setError(true));
      }}>{state?.status === 'checking' ? 'Checking…' : 'Check for updates'}</Button>
      {state?.status === 'ready' && <RestartToUpdate />}
    </Stack>
    {state?.status === 'downloading' && <Stack spacing={1} sx={{ width: '100%' }}>
      <Typography variant="body2">Downloading Kubus {state.version}… {state.percent ?? 0}%</Typography>
      <LinearProgress aria-label="Update download" variant="determinate" value={state.percent ?? 0} />
    </Stack>}
    {state?.status === 'ready' && <Alert severity="info">Kubus {state.version} is ready. Restart now, or it will install when you quit.</Alert>}
    {state?.status === 'installing' && <Alert severity="info">Restarting Kubus to install the update…</Alert>}
    {state?.status === 'up-to-date' && <Alert severity="success">Kubus is up to date.</Alert>}
    {(state?.status === 'error' || error) && <Alert severity="warning">{state?.error ?? 'The update check could not be completed. Try again.'}</Alert>}
    <Typography variant="body2" color="text.secondary">Kubus checks for updates in the background and downloads them automatically.</Typography>
  </Stack>;
}
