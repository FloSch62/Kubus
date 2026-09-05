import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import { DesktopUpdateAction, updateMessage, useDesktopUpdate } from './DesktopUpdateControls.js';

const DISMISSED_UPDATE_KEY = 'kubus-dismissed-update-version';

function readDismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_UPDATE_KEY);
  } catch {
    return null;
  }
}

function dismissVersion(version: string): void {
  try {
    window.localStorage.setItem(DISMISSED_UPDATE_KEY, version);
  } catch {
    /* Dismissal is a nicety; ignore blocked storage. */
  }
}

export function UpdateNotification() {
  return window.kubusDesktop ? <DesktopUpdateNotification /> : null;
}

function DesktopUpdateNotification() {
  const update = useDesktopUpdate();
  const [dismissed, setDismissed] = useState(readDismissedVersion);
  const key = `${update.latestVersion}:${update.status}`;
  const visible = ['available', 'downloading', 'ready', 'installing', 'error'].includes(update.status);
  const dismiss = () => { dismissVersion(key); setDismissed(key); };
  return (
    <Snackbar open={visible && dismissed !== key} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
      <Alert severity={update.status === 'error' ? 'error' : 'info'} variant="filled" onClose={dismiss} action={
        <Stack direction="row" spacing={0.5}>
          <DesktopUpdateAction update={update} compact />
          <Button color="inherit" size="small" onClick={dismiss}>Later</Button>
        </Stack>
      }>
        {updateMessage(update)}
      </Alert>
    </Snackbar>
  );
}
