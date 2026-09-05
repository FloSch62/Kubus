import { useSyncExternalStore } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import type { AppUpdateState } from '@kubus/shared';

const empty: AppUpdateState = { status: 'idle', currentVersion: '' };
const subscribe = (listener: () => void) => window.kubusDesktop?.onUpdateStateChanged(listener) ?? (() => {});
const snapshot = () => window.kubusDesktop?.getUpdateState() ?? empty;

export function useDesktopUpdate(): AppUpdateState {
  return useSyncExternalStore(subscribe, snapshot);
}

export function updateMessage(update: AppUpdateState): string {
  switch (update.status) {
    case 'idle': return 'Kubus checks for updates automatically.';
    case 'checking': return 'Checking for updates…';
    case 'up-to-date': return 'Kubus is up to date.';
    case 'available': return `Kubus ${update.latestVersion} is available.`;
    case 'downloading': return `Downloading Kubus ${update.latestVersion}${update.progress === undefined ? '…' : ` — ${Math.round(update.progress)}%`}`;
    case 'ready': return `Kubus ${update.latestVersion} is ready. Restart to install; active terminals and port forwards will close.`;
    case 'installing': return 'Restarting Kubus to install the update…';
    case 'disabled': return update.message ?? 'Updates are unavailable for this installation.';
    case 'error': return update.message ?? 'The update failed. Please try again.';
  }
}

export function DesktopUpdateAction({ update, compact = false }: { update: AppUpdateState; compact?: boolean }) {
  const action = update.status === 'available' ? 'download' : update.status === 'ready' ? 'install' : update.status === 'error' ? update.retry : undefined;
  if (!action) return null;
  return (
    <Button size={compact ? 'small' : 'medium'} color={compact ? 'inherit' : 'primary'} onClick={() => {
      if (action === 'download') window.kubusDesktop?.downloadUpdate();
      else if (action === 'install') window.kubusDesktop?.applyUpdate();
      else window.kubusDesktop?.checkForUpdate();
    }}>
      {action === 'install' ? 'Restart and install' : action === 'download' ? (update.status === 'error' ? 'Retry download' : 'Download update') : 'Retry check'}
    </Button>
  );
}

export function DesktopUpdateControls() {
  const update = useDesktopUpdate();
  const busy = ['checking', 'downloading', 'installing'].includes(update.status);
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={busy || update.status === 'disabled'} onClick={() => window.kubusDesktop?.checkForUpdate()}>
          Check for updates
        </Button>
        <DesktopUpdateAction update={update} />
      </Stack>
      <Alert severity={update.status === 'error' ? 'error' : update.status === 'up-to-date' ? 'success' : 'info'} variant="outlined">
        {updateMessage(update)}
      </Alert>
      {busy && <LinearProgress aria-label="Update progress" variant={update.progress === undefined ? 'indeterminate' : 'determinate'} value={update.progress} />}
    </Stack>
  );
}
