import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../api/http.js';
import { watchClient } from '../api/ws/watch-client.js';
import { dismissAuthInvalid, useBackendStore } from '../state/backend.js';

const RETRY_MS = 3000;

type Notice = 'outage' | 'session';

/**
 * Global banner for the two cross-cutting backend failure states: the server
 * not answering at all, and the session token no longer being accepted.
 * While either holds it pings until the server accepts a request, then
 * refetches everything so the app snaps back without a manual reload. The
 * session banner can also be closed by hand; the dismissal lasts until the
 * server accepts the token again, so a fresh rejection shows it anew.
 */
export function BackendStatusBanner() {
  const unreachable = useBackendStore((s) => s.unreachable);
  const authInvalid = useBackendStore((s) => s.authInvalid);
  const authDismissed = useBackendStore((s) => s.authInvalidDismissed);
  const queryClient = useQueryClient();
  const degraded = unreachable || authInvalid;

  useEffect(() => {
    if (!degraded) return;
    let cancelled = false;
    const timer = setInterval(() => {
      // An accepted response flips the store back via statusFetch.
      apiFetch('/api/app/info')
        .then(() => {
          if (cancelled) return;
          watchClient.reconnectNow();
          void queryClient.invalidateQueries();
        })
        .catch(() => {});
    }, RETRY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [degraded, queryClient]);

  // An outage is the more current observation: while the server is silent
  // the session state is unknown, so the retry notice wins over the session
  // notice until a response settles it.
  const notice: Notice | undefined = unreachable ? 'outage' : authInvalid ? 'session' : undefined;
  const open = notice === 'outage' || (notice === 'session' && !authDismissed);
  // The Snackbar keeps its child mounted through the exit fade, so remember
  // the last notice rather than letting the text flip while it fades out.
  const [shown, setShown] = useState(notice);
  if (notice && notice !== shown) setShown(notice);
  const session = shown === 'session';

  // Bottom-left keeps clear of ToastHost, which owns bottom-center.
  return (
    <Snackbar open={open} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
      <Alert
        severity={session ? 'error' : 'warning'}
        variant="filled"
        icon={session ? undefined : <CircularProgress color="inherit" size={18} />}
        onClose={session ? dismissAuthInvalid : undefined}
      >
        {session ? 'Session is no longer valid — restart Kubus to reconnect.' : 'Backend connection lost — retrying…'}
      </Alert>
    </Snackbar>
  );
}
