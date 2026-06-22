import { useState } from 'react';
import { Alert, Button, Chip, Snackbar, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import UndoIcon from '@mui/icons-material/Undo';
import type { KubeObject } from '@kubus/shared';
import { useRolloutHistory, useRolloutUndo } from '../../api/queries.js';
import { useIsProtected } from '../../state/clusters.js';
import { AgeCell } from '../AgeCell.js';
import { ConfirmDialog } from '../ConfirmDialog.js';

export function RolloutHistory({ ctx, kind, obj }: { ctx: string; kind: 'Deployment' | 'StatefulSet'; obj: KubeObject }) {
  const name = obj.metadata.name;
  const namespace = obj.metadata.namespace ?? '';
  const { data: history, isLoading, error } = useRolloutHistory({ ctx, kind, namespace, name });
  const undo = useRolloutUndo();
  const isProtected = useIsProtected(ctx);
  const [confirmRevision, setConfirmRevision] = useState<number | null>(null);
  const [toast, setToast] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
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
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {rev.images.join(', ') || '—'}
              </TableCell>
              <TableCell>{rev.createdAt ? <AgeCell timestamp={rev.createdAt} /> : '—'}</TableCell>
              <TableCell sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{rev.changeCause ?? ''}</TableCell>
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
                setToast({ severity: 'success', text: `Rolled back ${name} to revision ${confirmRevision}` });
              },
              onError: (e) => {
                setConfirmRevision(null);
                setToast({ severity: 'error', text: e instanceof Error ? e.message : String(e) });
              },
            },
          )
        }
      />
      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={toast?.severity} variant="filled" onClose={() => setToast(null)}>
          {toast?.text}
        </Alert>
      </Snackbar>
    </>
  );
}
