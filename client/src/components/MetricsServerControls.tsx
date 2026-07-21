import { useState } from 'react';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import type { MetricsServerStatus } from '@kubus/shared';
import { useInstallMetricsServer, useUninstallMetricsServer } from '../api/queries.js';
import { useIsProtected } from '../state/clusters.js';
import { showToast } from '../state/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { statusTextColor } from '../theme.js';

/**
 * One-click metrics-server install for a cluster: confirmation dialog with
 * the --kubelet-insecure-tls toggle most local clusters need, then a
 * server-side apply of the pinned upstream manifest.
 */
export function InstallMetricsServerButton({ ctx, size = 'small' }: { ctx: string; size?: 'small' | 'medium' }) {
  const [open, setOpen] = useState(false);
  const [insecureTls, setInsecureTls] = useState(false);
  const install = useInstallMetricsServer();
  const isProtected = useIsProtected(ctx);

  return (
    <>
      <Button size={size} variant="contained" startIcon={<DownloadOutlinedIcon />} onClick={() => setOpen(true)}>
        Install metrics-server
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Install metrics-server on {ctx}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            Applies the official metrics-server manifest to <b>kube-system</b> (Deployment, Service, RBAC and the{' '}
            <b>metrics.k8s.io</b> APIService). CPU and memory usage appear about a minute after the pod is ready.
          </DialogContentText>
          <FormControlLabel
            sx={{ mt: 1.5, alignItems: 'flex-start' }}
            control={<Checkbox checked={insecureTls} onChange={(e) => setInsecureTls(e.target.checked)} sx={{ mt: -1 }} />}
            label={
              <>
                <Typography variant="body2">Skip kubelet TLS verification (--kubelet-insecure-tls)</Typography>
                <Typography variant="caption" color="text.secondary">
                  Required on most local/dev clusters (kind, minikube, docker-desktop) whose kubelets use self-signed certificates.
                </Typography>
              </>
            }
          />
          {isProtected && (
            <Typography variant="body2" sx={{ mt: 1, color: statusTextColor('warning') }}>
              This cluster is marked protected — make sure installing cluster components here is intended.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={install.isPending}
            onClick={() =>
              install.mutate(
                { ctx, body: { insecureTls } },
                {
                  onSuccess: (r) => {
                    setOpen(false);
                    showToast('success', `metrics-server installed (${r.applied.length} resources applied) — waiting for first samples…`);
                  },
                  onError: (e) => {
                    setOpen(false);
                    showToast('error', `Install failed: ${e.message}`);
                  },
                },
              )
            }
          >
            {install.isPending ? 'Installing…' : 'Install'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export function UninstallMetricsServerButton({ ctx, status }: { ctx: string; status?: MetricsServerStatus }) {
  const [open, setOpen] = useState(false);
  const uninstall = useUninstallMetricsServer();
  const isProtected = useIsProtected(ctx);

  return (
    <>
      <Button size="small" color="error" variant="outlined" startIcon={<DeleteOutlinedIcon />} onClick={() => setOpen(true)}>
        Uninstall
      </Button>
      <ConfirmDialog
        open={open}
        title={`Uninstall metrics-server from ${ctx}`}
        danger
        confirmLabel="Uninstall"
        busy={uninstall.isPending}
        confirmText={isProtected ? 'metrics-server' : undefined}
        message={
          <>
            Deletes the metrics-server Deployment, Service, RBAC and the <b>metrics.k8s.io</b> APIService from <b>kube-system</b>.
            Live CPU/memory columns and usage graphs stop working.
            {status && !status.managedByKubus && (
              <>
                {' '}
                <b>This metrics-server was not installed by Kubus</b> — if your distribution manages it (k3s, cloud add-ons), it may be
                recreated automatically or should be removed through that tooling instead.
              </>
            )}
          </>
        }
        onClose={() => setOpen(false)}
        onConfirm={() =>
          uninstall.mutate(
            { ctx },
            {
              onSuccess: (r) => {
                setOpen(false);
                showToast('success', `metrics-server uninstalled: ${r.deleted.length} resources deleted${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
              },
              onError: (e) => {
                setOpen(false);
                showToast('error', `Uninstall failed: ${e.message}`);
              },
            },
          )
        }
      />
    </>
  );
}
