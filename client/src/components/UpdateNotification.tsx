import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import type { UpdateCheckResult } from '@kubus/shared';
import { DownloadUpdate, RestartToUpdate, useDesktopUpdate } from './DesktopUpdateControls.js';
import { checkForUpdate as checkForAppUpdate } from '../api/app.js';

const DISMISSED_UPDATE_KEY = 'kubus-dismissed-update-version';
const DISMISSED_DESKTOP_UPDATE_KEY = 'kubus-dismissed-desktop-update';

let updateCheck: Promise<UpdateCheckResult> | undefined;

function readDismissedVersion(key = DISMISSED_UPDATE_KEY): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function dismissVersion(version: string, key = DISMISSED_UPDATE_KEY): void {
  try {
    window.localStorage.setItem(key, version);
  } catch {
    /* Dismissal is a nicety; ignore blocked storage. */
  }
}

function checkForUpdate(): Promise<UpdateCheckResult> {
  updateCheck ??= checkForAppUpdate();
  return updateCheck;
}

export function UpdateNotification() {
  return window.kubusDesktop ? <DesktopUpdateNotification /> : <BrowserUpdateNotification />;
}

function DesktopUpdateNotification() {
  const state = useDesktopUpdate();
  // Availability and a completed download are separate decisions. Dismissing
  // the first notice must not hide the later install action for the same version.
  const notice = state?.version ? `${state.version}:${state.status}` : undefined;
  const [dismissed, setDismissed] = useState(() => readDismissedVersion(DISMISSED_DESKTOP_UPDATE_KEY));
  const dismiss = () => {
    if (notice) {
      setDismissed(notice);
      dismissVersion(notice, DISMISSED_DESKTOP_UPDATE_KEY);
    }
  };
  return <Snackbar open={!!state?.version && ['available', 'ready', 'error'].includes(state.status) && notice !== dismissed} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
    <Alert severity={state?.status === 'error' ? 'warning' : 'info'} variant="filled" action={<Stack direction="row" spacing={0.5}>
      {state?.status === 'ready' ? <RestartToUpdate compact /> : <DownloadUpdate compact />}
      <Button color="inherit" size="small" onClick={dismiss}>Later</Button>
    </Stack>}>
      {state?.status === 'error' ? state.error : `Kubus ${state?.version} ${state?.status === 'available' ? 'is available.' : 'is downloaded and ready to install.'}`}
    </Alert>
  </Snackbar>;
}

function BrowserUpdateNotification() {
  const [update, setUpdate] = useState<Extract<UpdateCheckResult, { available: true }> | null>(null);

  useEffect(() => {
    const check = checkForUpdate();

    let cancelled = false;
    void check
      .then((result) => {
        if (cancelled || !result.available) return;
        if (readDismissedVersion() === result.latestVersion) return;
        setUpdate(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    if (update) dismissVersion(update.latestVersion);
    setUpdate(null);
  };

  return (
    <Snackbar open={!!update} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
      <Alert
        severity="info"
        variant="filled"
        onClose={dismiss}
        action={
          update ? (
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" href={update.releaseUrl} target="_blank" rel="noreferrer" onClick={dismiss}>
                Download
              </Button>
              <Button color="inherit" size="small" onClick={dismiss}>
                Later
              </Button>
            </Stack>
          ) : undefined
        }
      >
        Kubus {update?.latestVersion} is available. You are running {update?.currentVersion}.
      </Alert>
    </Snackbar>
  );
}
