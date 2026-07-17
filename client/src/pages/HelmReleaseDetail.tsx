import { Suspense, lazy, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import DeleteIcon from '@mui/icons-material/Delete';
import UndoIcon from '@mui/icons-material/Undo';
import UpgradeIcon from '@mui/icons-material/Upgrade';
import DifferenceOutlinedIcon from '@mui/icons-material/DifferenceOutlined';
import Tooltip from '@mui/material/Tooltip';
import { useNavigate, useParams } from 'react-router';
import { dump as dumpYaml } from 'js-yaml';
import { useAppInfo, useHelmHistory, useHelmRelease, useHelmRollback, useHelmUninstall } from '../api/queries.js';
import { YamlEditor } from '../components/YamlEditor.js';
import { HelmRevisionDiffDialog } from '../components/HelmRevisionDiffDialog.js';
import { StatusChip } from '../components/StatusChip.js';
import { AgeCell } from '../components/AgeCell.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { useIsProtected } from '../state/clusters.js';
import { showToast } from '../state/toast.js';

const HelmUpgradeDialog = lazy(() => import('../components/HelmUpgradeDialog.js'));

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
  const [diffRange, setDiffRange] = useState<{ from: number; to: number } | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [deleteCrds, setDeleteCrds] = useState(false);
  const helmEngine = useAppInfo().data?.helmEngine ?? false;

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
            {release.driver === 'configmap' && <Chip label="configmap driver" variant="outlined" color="info" />}
            <Box sx={{ flex: 1 }} />
            <Tooltip title={helmEngine ? '' : 'Helm engine not built — run node helm-engine/build.mjs (requires Go)'}>
              <span>
                <Button startIcon={<UpgradeIcon />} variant="contained" disabled={!helmEngine} onClick={() => setUpgradeOpen(true)}>
                  Upgrade
                </Button>
              </span>
            </Tooltip>
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
                          <Button
                            size="small"
                            startIcon={<DifferenceOutlinedIcon />}
                            onClick={() => setDiffRange({ from: h.revision, to: release.revision })}
                          >
                            Diff
                          </Button>
                        )}
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
            This deletes every resource in the release manifest and removes the release records. Stored pre-delete and post-delete hooks are executed.
            {release && release.chartCrds.length > 0 && (
              <FormControlLabel
                sx={{ display: 'flex', mt: 1.5, alignItems: 'flex-start' }}
                control={<Checkbox size="small" color="error" checked={deleteCrds} onChange={(e) => setDeleteCrds(e.target.checked)} sx={{ mt: -0.5 }} />}
                label={
                  <>
                    Also delete the {release.chartCrds.length} CRDs shipped with this chart — <b>destroys every custom resource of these kinds, cluster-wide</b>{' '}
                    (helm never does this): <span style={{ fontSize: 12 }}>{release.chartCrds.join(', ')}</span>
                  </>
                }
              />
            )}
          </>
        }
        onClose={() => {
          setConfirmOpen(false);
          setDeleteCrds(false);
        }}
        onConfirm={() =>
          uninstall.mutate(
            { ctx: ctx!, ns: ns!, name: name!, deleteCrds },
            {
              onSuccess: (r) => {
                setConfirmOpen(false);
                setDeleteCrds(false);
                showToast(
                  'success',
                  `Uninstalled: ${r.deleted.length} resources deleted${r.crdsDeleted.length ? `, ${r.crdsDeleted.length} CRDs` : ''}${r.failed.length ? `, ${r.failed.length} failed` : ''}`,
                );
                setTimeout(() => navigate('/helm'), 1200);
              },
              onError: (e) => {
                setConfirmOpen(false);
                showToast('error', `Uninstall failed: ${e.message}`);
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
            prunes resources added since. Stored rollback hooks are executed.
          </>
        }
        onClose={() => setRollbackTo(null)}
        onConfirm={() =>
          rollback.mutate(
            { ctx: ctx!, ns: ns!, name: name!, revision: rollbackTo! },
            {
              onSuccess: (r) => {
                setRollbackTo(null);
                showToast('success', `Rolled back to revision ${rollbackTo} (new revision ${r.newRevision}, ${r.applied.length} applied${r.pruned.length ? `, ${r.pruned.length} pruned` : ''}${r.failed.length ? `, ${r.failed.length} failed` : ''})`);
              },
              onError: (e) => {
                setRollbackTo(null);
                showToast('error', `Rollback failed: ${e.message}`);
              },
            },
          )
        }
      />
      {diffRange && (
        <HelmRevisionDiffDialog
          ctx={ctx!}
          ns={ns!}
          name={name!}
          revisions={history ?? []}
          from={diffRange.from}
          to={diffRange.to}
          onClose={() => setDiffRange(null)}
        />
      )}
      {upgradeOpen && release && (
        <Suspense fallback={null}>
          <HelmUpgradeDialog ctx={ctx!} ns={ns!} name={name!} release={release} isProtected={isProtected} onClose={() => setUpgradeOpen(false)} />
        </Suspense>
      )}
    </Box>
  );
}
