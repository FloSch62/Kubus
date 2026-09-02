import { useEffect, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import type { KubeObject } from '@kubus/shared';
import { useApplyResource, useDryRunResource } from '../../api/queries.js';
import { DiffViewer } from '../DiffViewer.js';

export interface ReviewTarget {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: string;
  name: string;
  namespace?: string;
}

/**
 * Diff + server dry-run gate in front of a PUT. The caller hands over the
 * manifest to apply and the two diff sides (which may be masked); the dialog
 * runs the dry-run on open and only enables Apply once the server accepts.
 */
export function ReviewApplyDialog({
  sel,
  yamlBody,
  left,
  right,
  notice,
  onClose,
  onApplied,
  onConflict,
}: {
  sel: ReviewTarget;
  yamlBody: string;
  left: string;
  right: string;
  /** Extra alert above the diff (e.g. masked Secret values). */
  notice?: ReactNode;
  onClose: () => void;
  onApplied: (updated: KubeObject) => void;
  /** The PUT hit a 409; the caller refreshes and rebases. */
  onConflict: () => void;
}) {
  const apply = useApplyResource();
  const dryRun = useDryRunResource();
  const [error, setError] = useState<string>();

  const dryRunMutate = dryRun.mutate;
  useEffect(() => {
    dryRunMutate({ ctx: sel.ctx, yamlBody });
  }, [dryRunMutate, sel.ctx, yamlBody]);

  const doApply = async () => {
    setError(undefined);
    try {
      const updated = await apply.mutateAsync({ ctx: sel.ctx, group: sel.group, version: sel.version, plural: sel.plural, name: sel.name, namespace: sel.namespace, yamlBody });
      onApplied(updated);
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        onConflict();
        setError(`${(err as Error).message} — the resource changed on the server; the diff has been refreshed, review it and apply again.`);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const findings = dryRun.data?.findings ?? [];
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        Review changes — {sel.namespace ? `${sel.namespace}/` : ''}
        {sel.name}
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, display: 'flex', flexDirection: 'column', height: '68vh' }}>
        {error && (
          <Alert severity="error" onClose={() => setError(undefined)} sx={{ borderRadius: 0, flexShrink: 0 }}>
            {error}
          </Alert>
        )}
        {dryRun.isError && (
          <Alert severity="error" sx={{ borderRadius: 0, flexShrink: 0 }}>
            Dry-run failed: {dryRun.error instanceof Error ? dryRun.error.message : 'unknown error'}
          </Alert>
        )}
        {findings.map((finding, i) => (
          <Alert key={`${finding.field ?? ''}:${i}`} severity={finding.severity === 'error' ? 'error' : finding.severity} sx={{ borderRadius: 0, flexShrink: 0 }}>
            {finding.field ? `${finding.field}: ` : ''}
            {finding.message}
          </Alert>
        ))}
        {dryRun.data?.ok && findings.length === 0 && (
          <Alert severity="success" sx={{ borderRadius: 0, flexShrink: 0 }}>
            Server dry-run accepted this change.
          </Alert>
        )}
        {notice}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <DiffViewer left={left} right={right} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={apply.isPending || dryRun.isPending || !dryRun.data?.ok} onClick={() => void doApply()}>
          {apply.isPending ? 'Applying…' : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
