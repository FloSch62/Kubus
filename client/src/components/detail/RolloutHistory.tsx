import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import UndoIcon from '@mui/icons-material/Undo';
import type { KubeObject } from '@kubus/shared';
import { useRolloutHistory, useRolloutUndo } from '../../api/queries.js';
import { useIsProtected } from '../../state/clusters.js';
import { showToast } from '../../state/toast.js';
import { AgeCell } from '../AgeCell.js';
import { ConfirmDialog } from '../ConfirmDialog.js';

export function RolloutHistory({ ctx, kind, obj }: { ctx: string; kind: 'Deployment' | 'StatefulSet' | 'DaemonSet'; obj: KubeObject }) {
  const name = obj.metadata.name;
  const namespace = obj.metadata.namespace ?? '';
  const { data: history, isLoading, error } = useRolloutHistory({ ctx, kind, namespace, name });
  const undo = useRolloutUndo();
  const isProtected = useIsProtected(ctx);
  const [confirmRevision, setConfirmRevision] = useState<number | null>(null);
  const paused = !!(obj.spec as { paused?: boolean })?.paused;

  if (error) return <Alert severity="error" sx={{ m: 2 }}>{error.message}</Alert>;
  if (isLoading) return <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>Loading…</Typography>;
  if (!history?.length) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        No rollout history. Revisions may have been pruned by revisionHistoryLimit.
      </Typography>
    );
  }

  return (
    <>
      {paused && (
        <Alert severity="info" sx={{ m: 2, mb: 0 }}>
          Rollout is paused — a rollback will be recorded but won't roll out until the rollout is resumed.
        </Alert>
      )}
      <Table size="small" sx={{ mt: 1 }}>
        <TableHead>
          <TableRow>
            <TableCell>Revision</TableCell>
            <TableCell>Images</TableCell>
            <TableCell>Created</TableCell>
            <TableCell>Change cause</TableCell>
            <TableCell align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {history.map((rev) => (
            <TableRow key={rev.name} hover>
              <TableCell>
                {rev.revision}
                {rev.current && <Chip label="current" size="small" color="primary" variant="outlined" sx={{ ml: 1, height: 18 }} />}
              </TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }} title={rev.images.join(', ')}>
                <Box sx={{ maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rev.images.join(', ') || '—'}</Box>
              </TableCell>
              <TableCell>{rev.createdAt ? <AgeCell timestamp={rev.createdAt} /> : '—'}</TableCell>
              <TableCell title={rev.changeCause}>
                <Box sx={{ maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rev.changeCause ?? ''}</Box>
              </TableCell>
              <TableCell align="right">
                {!rev.current && (
                  <Button size="small" startIcon={<UndoIcon />} onClick={() => setConfirmRevision(rev.revision)}>
                    Roll back
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={confirmRevision !== null}
        title={`Roll back ${name}`}
        message={
          <>
            Roll back <b>{namespace}/{name}</b> to revision <b>{confirmRevision}</b> on cluster <b>{ctx}</b>? This re-applies that
            revision's pod template as a new revision.
          </>
        }
        confirmLabel="Roll back"
        danger
        busy={undo.isPending}
        confirmText={isProtected ? name : undefined}
        onClose={() => setConfirmRevision(null)}
        onConfirm={() =>
          undo.mutate(
            { ctx, body: { kind, namespace, name, toRevision: confirmRevision ?? undefined } },
            {
              onSuccess: () => {
                setConfirmRevision(null);
                showToast('success', `Rolled back ${name} to revision ${confirmRevision}`);
              },
              onError: (e) => {
                setConfirmRevision(null);
                showToast('error', e instanceof Error ? e.message : String(e));
              },
            },
          )
        }
      />
    </>
  );
}
