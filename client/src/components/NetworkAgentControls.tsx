import { useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import type { NetworkAgentStatus } from '@kubus/shared';
import { useInstallNetworkAgent, useUninstallNetworkAgent } from '../api/queries.js';
import { useIsProtected } from '../state/clusters.js';
import { showToast } from '../state/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { statusTextColor } from '../theme.js';

/**
 * One-click network-agent install for a cluster: a confirmation dialog that
 * spells out the privileged-DaemonSet trade-off, then a server-side apply of
 * the vendored coroot-node-agent manifest.
 */
export function InstallNetworkAgentButton({ ctx, size = 'small' }: { ctx: string; size?: 'small' | 'medium' }) {
  const [open, setOpen] = useState(false);
  const install = useInstallNetworkAgent();
  const isProtected = useIsProtected(ctx);

  return (
    <>
      <Button size={size} variant="contained" startIcon={<DownloadOutlinedIcon />} onClick={() => setOpen(true)}>
        Install network agent
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Install network agent on {ctx}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            Deploys <b>Microsoft Retina</b> (open source, works with any CNI) into <b>kube-system</b>: an eBPF agent DaemonSet, a small
            operator Deployment, two CRDs and their RBAC. Kubus reads the traffic counters through the Kubernetes API — no Prometheus
            involved.
          </DialogContentText>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            The agent pods use the <b>host network and elevated capabilities</b> (privileged init container) — required for eBPF — on
            Linux nodes. Traffic rates appear about a minute after the pods are ready.
          </Typography>
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
                { ctx },
                {
                  onSuccess: (r) => {
                    setOpen(false);
                    showToast('success', `Network agent installed (${r.applied.length} resources applied) — waiting for first samples…`);
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

/**
 * Uninstall with confirmation. `trigger="menu"` renders a ⋮ button whose menu
 * holds the (destructive) uninstall item, for page headers where a red button
 * would be the loudest thing on screen.
 */
export function UninstallNetworkAgentButton({ ctx, status, trigger = 'button' }: { ctx: string; status?: NetworkAgentStatus; trigger?: 'button' | 'menu' }) {
  const [open, setOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const uninstall = useUninstallNetworkAgent();
  const isProtected = useIsProtected(ctx);

  return (
    <>
      {trigger === 'menu' ? (
        <>
          <Tooltip title="More actions">
            <IconButton size="small" aria-label={`More network agent actions for ${ctx}`} onClick={(e) => setMenuAnchor(e.currentTarget)}>
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                setOpen(true);
              }}
              sx={{ color: 'error.main' }}
            >
              <ListItemIcon sx={{ color: 'inherit' }}>
                <DeleteOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Uninstall network agent…</ListItemText>
            </MenuItem>
          </Menu>
        </>
      ) : (
        <Button size="small" color="error" variant="outlined" startIcon={<DeleteOutlinedIcon />} onClick={() => setOpen(true)}>
          Uninstall
        </Button>
      )}
      <ConfirmDialog
        open={open}
        title={`Uninstall network agent from ${ctx}`}
        danger
        confirmLabel="Uninstall"
        busy={uninstall.isPending}
        confirmText={isProtected ? 'network-agent' : undefined}
        message={
          <>
            Deletes the Retina agent DaemonSet, operator, CRDs and RBAC from <b>kube-system</b>. Traffic graphs and the link table stop
            working.
            {status && !status.managedByKubus && (
              <>
                {' '}
                <b>This Retina install was not created by Kubus</b> — if something else manages it (AKS add-ons, your own Helm release),
                it may be recreated automatically or should be removed through that tooling instead.
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
                showToast('success', `Network agent uninstalled: ${r.deleted.length} resources deleted${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
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
