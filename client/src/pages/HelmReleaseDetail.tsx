import { useMemo, useState } from 'react';
import { Alert, Box, Breadcrumbs, Button, Chip, Link, Snackbar, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import UndoIcon from '@mui/icons-material/Undo';
import { useNavigate, useParams } from 'react-router';
import { dump as dumpYaml } from 'js-yaml';
import { useHelmHistory, useHelmRelease, useHelmRollback, useHelmUninstall } from '../api/queries.js';
import { YamlEditor } from '../components/YamlEditor.js';
import { StatusChip } from '../components/StatusChip.js';
import { AgeCell } from '../components/AgeCell.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { useIsProtected } from '../state/clusters.js';

export function HelmReleaseDetailPage() {
  const { ctx, ns, name } = useParams<{ ctx: string; ns: string; name: string }>();
  const isProtected = useIsProtected(ctx ?? '');
  const { data: release, isLoading, error } = useHelmRelease(ctx, ns, name);
  const { data: history } = useHelmHistory(ctx, ns, name);
  const uninstall = useHelmUninstall();
  const rollback = useHelmRollback();
  const navigate = useNavigate();
  const [tab, setTab] = useState('values');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rollbackTo, setRollbackTo] = useState<number | null>(null);
  const [toast, setToast] = useState<string>();

  const valuesYaml = useMemo(() => (release ? dumpYaml(release.values ?? {}, { noRefs: true }) : ''), [release]);
  const computedYaml = useMemo(() => (release ? dumpYaml(release.computedValues ?? {}, { noRefs: true }) : ''), [release]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 2 }}>
      <Breadcrumbs sx={{ mb: 1 }}>
        <Link component="button" underline="hover" onClick={() => navigate('/helm')}>
          Helm Releases
        </Link>
        <Typography color="text.primary">{name}</Typography>
      </Breadcrumbs>
      {error && <Alert severity="error">{error.message}</Alert>}
      {release && (
        <>
          <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography variant="h6">{release.name}</Typography>
            <StatusChip status={release.status} />
            <Chip label={`${release.chart}-${release.chartVersion}`} variant="outlined" />
            {release.appVersion && <Chip label={`app ${release.appVersion}`} variant="outlined" />}
            <Chip label={`rev ${release.revision}`} variant="outlined" />
            <Chip label={`${ns} @ ${ctx}`} variant="outlined" />
            <Box sx={{ flex: 1 }} />
            <Button color="error" startIcon={<DeleteIcon />} variant="outlined" onClick={() => setConfirmOpen(true)}>
              Uninstall
            </Button>
          </Stack>
          <Tabs value={tab} onChange={(_e, v) => setTab(v as string)} sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}>
            <Tab value="values" label="Values" sx={{ minHeight: 36 }} />
            <Tab value="computed" label="Computed values" sx={{ minHeight: 36 }} />
            <Tab value="manifest" label="Manifest" sx={{ minHeight: 36 }} />
            <Tab value="history" label="History" sx={{ minHeight: 36 }} />
            {release.notes && <Tab value="notes" label="Notes" sx={{ minHeight: 36 }} />}
          </Tabs>
          <Box sx={{ flex: 1, minHeight: 0, pt: 1 }}>
            {tab === 'values' && <YamlEditor value={valuesYaml || '# no user-supplied values\n'} readOnly />}
            {tab === 'computed' && <YamlEditor value={computedYaml} readOnly />}
            {tab === 'manifest' && <YamlEditor value={release.manifest} readOnly />}
            {tab === 'history' && (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Revision</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Chart</TableCell>
                    <TableCell>App version</TableCell>
                    <TableCell>Updated</TableCell>
                    <TableCell>Description</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(history ?? []).map((h, idx) => (
                    <TableRow key={h.revision}>
                      <TableCell>{h.revision}</TableCell>
                      <TableCell>
                        <StatusChip status={h.status} />
                      </TableCell>
                      <TableCell>
                        {h.chart}-{h.chartVersion}
                      </TableCell>
                      <TableCell>{h.appVersion ?? ''}</TableCell>
                      <TableCell>{h.updated ? <AgeCell timestamp={h.updated} /> : ''}</TableCell>
                      <TableCell>{h.description ?? ''}</TableCell>
                      <TableCell align="right">
                        {idx > 0 && (
                          <Button size="small" startIcon={<UndoIcon />} onClick={() => setRollbackTo(h.revision)}>
                            Roll back
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {tab === 'notes' && (
              <Box component="pre" sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', p: 1 }}>
                {release.notes}
              </Box>
            )}
          </Box>
        </>
      )}
      {isLoading && <Typography color="text.secondary">Loading…</Typography>}
      <ConfirmDialog
        open={confirmOpen}
        title={`Uninstall ${name}`}
        danger
        confirmLabel="Uninstall"
        busy={uninstall.isPending}
        confirmText={isProtected ? name : undefined}
        message={
          <>
            This deletes every resource in the release manifest and removes the release records. <b>Helm hooks are not executed.</b>
          </>
        }
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          uninstall.mutate(
            { ctx: ctx!, ns: ns!, name: name! },
            {
              onSuccess: (r) => {
                setConfirmOpen(false);
                setToast(`Uninstalled: ${r.deleted.length} resources deleted${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
                setTimeout(() => navigate('/helm'), 1200);
              },
              onError: (e) => {
                setConfirmOpen(false);
                setToast(`Uninstall failed: ${e.message}`);
              },
            },
          )
        }
      />
      <ConfirmDialog
        open={rollbackTo !== null}
        title={`Roll back ${name}`}
        danger
        confirmLabel="Roll back"
        busy={rollback.isPending}
        confirmText={isProtected ? name : undefined}
        message={
          <>
            Roll back <b>{ns}/{name}</b> to revision <b>{rollbackTo}</b>? This re-applies that revision's manifest as a new revision and
            prunes resources added since. <b>Helm hooks are not executed.</b>
          </>
        }
        onClose={() => setRollbackTo(null)}
        onConfirm={() =>
          rollback.mutate(
            { ctx: ctx!, ns: ns!, name: name!, revision: rollbackTo! },
            {
              onSuccess: (r) => {
                setRollbackTo(null);
                setToast(`Rolled back to revision ${rollbackTo} (new revision ${r.newRevision}, ${r.applied.length} applied${r.pruned.length ? `, ${r.pruned.length} pruned` : ''}${r.failed.length ? `, ${r.failed.length} failed` : ''})`);
              },
              onError: (e) => {
                setRollbackTo(null);
                setToast(`Rollback failed: ${e.message}`);
              },
            },
          )
        }
      />
      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(undefined)} message={toast} />
    </Box>
  );
}
