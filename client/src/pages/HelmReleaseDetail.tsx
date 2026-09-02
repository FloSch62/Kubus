import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteIcon from '@mui/icons-material/Delete';
import DifferenceOutlinedIcon from '@mui/icons-material/DifferenceOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import UndoIcon from '@mui/icons-material/Undo';
import UpgradeIcon from '@mui/icons-material/Upgrade';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { dump as dumpYaml } from 'js-yaml';
import type { HelmRevision } from '@kubus/shared';
import {
  useAppInfo,
  useHelmHistory,
  useHelmOperations,
  useHelmRelease,
  useHelmReleaseResources,
  useHelmRollback,
  useHelmUninstall,
  useHelmUpdates,
} from '../api/queries.js';
import { YamlEditor } from '../components/YamlEditor.js';
import { HelmRevisionDiffDialog } from '../components/HelmRevisionDiffDialog.js';
import { StatusChip } from '../components/StatusChip.js';
import { AgeCell } from '../components/AgeCell.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { useIsProtected } from '../state/clusters.js';
import { showToast } from '../state/toast.js';
import { HelmOperationErrorAlert } from '../components/HelmOperationErrorAlert.js';
import { HelmOperationStatus } from '../components/HelmOperationStatus.js';
import { HelmLiveBadge } from '../components/HelmLiveBadge.js';
import { HelmReleaseResources, helmResourceSummary, helmResourceSummaryText } from '../components/HelmReleaseResources.js';
import { ChartSourceLink, preferredChartSource } from '../components/ChartSourceLink.js';
import { SummaryStrip, type SummaryItem } from '../components/detail/SummaryStrip.js';
import { DetailStack, Section } from '../components/detail/Section.js';
import { Fact, Facts } from '../components/detail/Facts.js';

const HelmUpgradeDialog = lazy(() => import('../components/HelmUpgradeDialog.js'));

const ROLLBACK_STATUSES = new Set(['deployed', 'superseded']);
type ReleaseTab = 'overview' | 'values' | 'computed' | 'manifest' | 'history' | 'notes';

/** Revisions Helm can roll back to: earlier ones that once reached a settled state. */
function rollbackTargets(history: HelmRevision[] | undefined, current: number | undefined): HelmRevision[] {
  return (history ?? []).filter((revision) => revision.revision < (current ?? 0) && ROLLBACK_STATUSES.has(revision.status));
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function HelmReleaseDetailPage() {
  const { ctx, ns, name } = useParams<{ ctx: string; ns: string; name: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const isProtected = useIsProtected(ctx ?? '');
  const { data: release, isLoading, error } = useHelmRelease(ctx, ns, name);
  const { data: history } = useHelmHistory(ctx, ns, name);
  const uninstall = useHelmUninstall();
  const rollback = useHelmRollback();
  const operations = useHelmOperations();
  const navigate = useNavigate();
  const [tab, setTab] = useState<ReleaseTab>('overview');
  const resources = useHelmReleaseResources(ctx, ns, name, { active: tab === 'overview' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rollbackTo, setRollbackTo] = useState<number | null>(null);
  const [rollbackMenuAnchor, setRollbackMenuAnchor] = useState<HTMLElement | null>(null);
  const [diffRange, setDiffRange] = useState<{ from: number; to: number } | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [deleteCrds, setDeleteCrds] = useState(false);
  const [operationError, setOperationError] = useState<Error>();
  const helmEngine = useAppInfo().data?.helmEngine ?? false;
  const latestOperation = operations.data?.find((operation) => operation.ctx === ctx && operation.namespace === ns && operation.releaseName === name);
  const activeOperation = latestOperation?.status === 'running' ? latestOperation : undefined;

  const valuesYaml = useMemo(() => (release ? dumpYaml(release.values ?? {}, { noRefs: true }) : ''), [release]);
  const computedYaml = useMemo(() => (release ? dumpYaml(release.computedValues ?? {}, { noRefs: true }) : ''), [release]);
  const updateItems = useMemo(
    () =>
      release && ctx && ns && name
        ? [{ id: `${ctx}/${ns}/${name}`, chart: release.chart, currentVersion: release.chartVersion, currentAppVersion: release.appVersion }]
        : [],
    [ctx, name, ns, release],
  );
  const updates = useHelmUpdates(updateItems);
  const updateHint = updates.data?.[0];
  const availableUpdate = updateHint?.available ? updateHint : undefined;
  const chartSource = preferredChartSource(release?.chartSources, release?.chartHome);
  const targets = useMemo(() => rollbackTargets(history, release?.revision), [history, release?.revision]);
  const lastGoodRevision = targets[0];
  const previousRevision = history?.find((revision) => revision.revision < (release?.revision ?? 0));
  const resourceSummary = helmResourceSummary(resources.data);

  // "Upgrade…" from the releases list lands here with ?action=upgrade: open the
  // dialog once the release is known, then drop the parameter so a reload or
  // a back-navigation doesn't reopen it.
  const requestedAction = searchParams.get('action');
  useEffect(() => {
    if (requestedAction !== 'upgrade' || !release) return;
    if (helmEngine && !activeOperation) setUpgradeOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [activeOperation, helmEngine, release, requestedAction, searchParams, setSearchParams]);

  const summaryItems: Array<SummaryItem | false | undefined> = release
    ? [
        { label: 'Status', value: <StatusChip status={release.status} />, title: release.status },
        { label: 'Revision', value: String(release.revision) },
        { label: 'Chart', value: `${release.chart}-${release.chartVersion}`, span: 2 },
        !!release.appVersion && { label: 'App version', value: release.appVersion },
        {
          label: 'Resources',
          value: resources.data ? helmResourceSummaryText(resourceSummary) : 'checking…',
          tone: resources.data ? (resourceSummary.failed ? 'error' : resourceSummary.ready < resourceSummary.total ? 'warning' : 'success') : undefined,
          hint: 'Objects from the manifest resolved against the cluster; workloads count as ready when rolled out.',
        },
        {
          label: 'Update',
          value: availableUpdate
            ? `${availableUpdate.latestVersion} available`
            : updates.isFetching
              ? 'checking…'
              : updateHint?.reason === 'up-to-date'
                ? 'Up to date'
                : 'Source unknown',
          tone: availableUpdate ? 'info' : undefined,
          hint: availableUpdate
            ? `Found in ${availableUpdate.repo ?? 'a matching chart source'}${availableUpdate.latestAppVersion ? `, app ${availableUpdate.latestAppVersion}` : ''}`
            : updateHint && updateHint.reason !== 'up-to-date'
              ? 'Kubus could not safely match this release to a chart source that also contains its current version.'
              : undefined,
        },
        {
          label: 'Updated',
          value: release.updated ? (
            <>
              <AgeCell timestamp={release.updated} /> ago
            </>
          ) : (
            '—'
          ),
          title: formatDate(release.updated),
        },
      ]
    : [];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 2 }}>
      <Breadcrumbs sx={{ mb: 1 }}>
        <Link component="button" underline="hover" onClick={() => navigate('/helm')}>
          Helm Releases
        </Link>
        <Typography color="text.primary">{name}</Typography>
      </Breadcrumbs>
      {error && <Alert severity="error">{error.message}</Alert>}
      {operationError ? <HelmOperationErrorAlert error={operationError} /> : null}
      {latestOperation ? (
        <Box sx={{ mb: 1.5 }}>
          <HelmOperationStatus operation={latestOperation} />
        </Box>
      ) : null}
      {release && (
        <>
          {release.status === 'failed' ? (
            <Alert
              severity="error"
              sx={{ mb: 1.5 }}
              action={
                lastGoodRevision ? (
                  <Stack direction="row" spacing={0.5}>
                    <Button color="inherit" size="small" onClick={() => setDiffRange({ from: lastGoodRevision.revision, to: release.revision })}>
                      Review diff
                    </Button>
                    <Button color="inherit" size="small" onClick={() => setRollbackTo(lastGoodRevision.revision)}>
                      Recovery options
                    </Button>
                  </Stack>
                ) : undefined
              }
            >
              <AlertTitle>Revision {release.revision} failed</AlertTitle>
              {release.description ? `${release.description}. ` : ''}Some resources may already have changed. Inspect workload logs and events, compare with the last
              successful revision, and follow the chart’s recovery guidance. Rollback only restores Kubernetes manifests; it cannot reverse database or data
              migrations.
            </Alert>
          ) : release.status.startsWith('pending') ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              This release is {release.status}. Another operation may still be running; avoid starting a second change until it completes or the release is recovered.
            </Alert>
          ) : null}
          <Stack direction="row" sx={{ mb: 1.5, gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography variant="h5" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
              {release.name}
            </Typography>
            <StatusChip status={release.status} size="md" />
            <Typography variant="body2" color="text.secondary">
              {ns} @ {ctx}
            </Typography>
            {ctx ? <HelmLiveBadge contexts={[ctx]} /> : null}
            <Box sx={{ flex: 1 }} />
            <Stack direction="row" sx={{ gap: 0.75, flexWrap: 'wrap' }}>
              <Tooltip title={helmEngine ? '' : 'Helm engine not built — run node helm-engine/build.mjs (requires Go)'}>
                <span>
                  <Button size="small" startIcon={<UpgradeIcon />} variant="contained" disabled={!helmEngine || !!activeOperation} onClick={() => setUpgradeOpen(true)}>
                    {activeOperation
                      ? `${activeOperation.kind} running`
                      : availableUpdate
                        ? `Upgrade to ${availableUpdate.latestVersion}`
                        : release.status === 'failed'
                          ? 'Retry / recover'
                          : 'Upgrade'}
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={targets.length ? '' : 'No earlier deployed revision to roll back to'}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<UndoIcon />}
                    endIcon={<KeyboardArrowDownIcon />}
                    disabled={!targets.length || !!activeOperation}
                    aria-haspopup="menu"
                    onClick={(event) => setRollbackMenuAnchor(event.currentTarget)}
                  >
                    Roll back
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={previousRevision ? `Compare revision ${previousRevision.revision} with the current revision` : 'This release has a single revision'}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<DifferenceOutlinedIcon />}
                    disabled={!previousRevision}
                    onClick={() => previousRevision && setDiffRange({ from: previousRevision.revision, to: release.revision })}
                  >
                    Diff
                  </Button>
                </span>
              </Tooltip>
              <Button size="small" color="error" startIcon={<DeleteIcon />} variant="outlined" disabled={!!activeOperation} onClick={() => setConfirmOpen(true)}>
                Uninstall
              </Button>
            </Stack>
          </Stack>
          <Menu open={rollbackMenuAnchor !== null} anchorEl={rollbackMenuAnchor} onClose={() => setRollbackMenuAnchor(null)}>
            {targets.map((revision) => (
              <MenuItem
                key={revision.revision}
                onClick={() => {
                  setRollbackMenuAnchor(null);
                  setRollbackTo(revision.revision);
                }}
              >
                <ListItemText
                  primary={`Revision ${revision.revision} · ${revision.chart}-${revision.chartVersion}`}
                  secondary={`${revision.status}${revision.updated ? `, ${formatDate(revision.updated)}` : ''}${revision.description ? `, ${revision.description}` : ''}`}
                  slotProps={{ secondary: { noWrap: true, sx: { maxWidth: 420 } } }}
                />
              </MenuItem>
            ))}
          </Menu>
          <SummaryStrip items={summaryItems} />
          <Tabs value={tab} onChange={(_e, v) => setTab(v as ReleaseTab)} sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36, mt: 1.5 }}>
            <Tab value="overview" label="Overview" sx={{ minHeight: 36 }} />
            <Tab value="values" label="Values" sx={{ minHeight: 36 }} />
            <Tab value="computed" label="Computed values" sx={{ minHeight: 36 }} />
            <Tab value="manifest" label="Manifest" sx={{ minHeight: 36 }} />
            <Tab value="history" label={`History · ${history?.length ?? release.revision}`} sx={{ minHeight: 36 }} />
            {release.notes && <Tab value="notes" label="Notes" sx={{ minHeight: 36 }} />}
          </Tabs>
          <Box sx={{ flex: 1, minHeight: 0, pt: 1, overflow: tab === 'overview' || tab === 'history' || tab === 'notes' ? 'auto' : 'hidden', display: 'flex', flexDirection: 'column' }}>
            {tab === 'overview' && ctx && ns && name && (
              <DetailStack sx={{ p: 0, pb: 2 }}>
                <Section title="Resources" count={resourceSummary.total + resourceSummary.hooks} flush>
                  <HelmReleaseResources ctx={ctx} ns={ns} name={name} active={tab === 'overview'} />
                </Section>
                <Section title="Details" defaultOpen>
                  <Facts>
                    <Fact label="Chart">
                      {release.chart}-{release.chartVersion}
                      {chartSource ? (
                        <>
                          {' '}
                          <ChartSourceLink url={chartSource} />
                        </>
                      ) : null}
                    </Fact>
                    <Fact label="App version">{release.appVersion}</Fact>
                    <Fact label="Description">{release.description}</Fact>
                    <Fact label="First deployed">{formatDate(release.firstDeployed)}</Fact>
                    <Fact label="Last deployed">{formatDate(release.updated)}</Fact>
                    <Fact label="Namespace">{ns}</Fact>
                    <Fact label="Cluster">{ctx}</Fact>
                    <Fact label="Storage driver" hint="Where Helm keeps this release's records">
                      {release.driver === 'configmap' ? 'configmap' : 'secret'}
                    </Fact>
                    <Fact label="Dependencies" hint="Subcharts declared by the chart; values-only upgrades need a chart source when > 0">
                      {release.chartDependencies ? String(release.chartDependencies) : 'none'}
                    </Fact>
                    <Fact label="Hooks">{release.hookCount ? String(release.hookCount) : 'none'}</Fact>
                    <Fact label="Chart CRDs" hint="CRDs shipped in the chart's crds/ directory; kept on uninstall unless you opt in">
                      {release.chartCrds.length ? release.chartCrds.join(', ') : undefined}
                    </Fact>
                    <Fact label="Sources">
                      {release.chartSources.length ? (
                        <Stack sx={{ gap: 0.25 }}>
                          {release.chartSources.map((source) => (
                            <Link key={source} href={source} target="_blank" rel="noreferrer" underline="hover" sx={{ wordBreak: 'break-all' }}>
                              {source}
                            </Link>
                          ))}
                        </Stack>
                      ) : undefined}
                    </Fact>
                  </Facts>
                </Section>
              </DetailStack>
            )}
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
                  {(history ?? []).map((h) => {
                    const current = h.revision === release.revision;
                    return (
                      <TableRow key={h.revision} selected={current}>
                        <TableCell sx={{ fontWeight: current ? 600 : undefined }}>
                          {h.revision}
                          {current ? <Chip size="small" label="current" variant="outlined" sx={{ ml: 1 }} /> : null}
                        </TableCell>
                        <TableCell>
                          <StatusChip status={h.status} />
                        </TableCell>
                        <TableCell>
                          {h.chart}-{h.chartVersion}
                        </TableCell>
                        <TableCell>{h.appVersion ?? ''}</TableCell>
                        <TableCell>{h.updated ? <AgeCell timestamp={h.updated} /> : ''}</TableCell>
                        <TableCell sx={{ maxWidth: 360 }}>
                          <Tooltip title={h.description ?? ''} placement="top-start">
                            <Typography variant="body2" noWrap>
                              {h.description ?? ''}
                            </Typography>
                          </Tooltip>
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {!current && (
                            <Button size="small" startIcon={<DifferenceOutlinedIcon />} onClick={() => setDiffRange({ from: h.revision, to: release.revision })}>
                              Diff
                            </Button>
                          )}
                          {h.revision < release.revision && ROLLBACK_STATUSES.has(h.status) && (
                            <Button size="small" startIcon={<UndoIcon />} disabled={!!activeOperation} onClick={() => setRollbackTo(h.revision)}>
                              Roll back
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {tab === 'notes' && (
              <Box component="pre" sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', p: 1, m: 0 }}>
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
            This deletes every resource in the release manifest, then removes the release records only after cleanup succeeds. Stored pre-delete and post-delete
            hooks are executed.
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
                if (r.failed.length) {
                  setOperationError(
                    new Error(
                      `Uninstall incomplete: ${r.failed
                        .slice(0, 3)
                        .map((item) => `${item.resource}: ${item.error}`)
                        .join('; ')}`,
                    ),
                  );
                  showToast(
                    'error',
                    `Uninstall incomplete: ${r.failed.length} item${r.failed.length === 1 ? '' : 's'} failed${
                      r.recordsRetained ? '; release history was retained for inspection and retry' : ''
                    }`,
                  );
                  return;
                }
                showToast(
                  'success',
                  `Uninstalled: ${r.deleted.length} resources deleted${r.crdsDeleted.length ? `, ${r.crdsDeleted.length} CRDs` : ''}`,
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
          <Stack spacing={1}>
            <span>
              Roll back <b>{ns}/{name}</b> to revision <b>{rollbackTo}</b>? This re-applies that revision's manifest as a new revision, prunes resources added since,
              runs stored rollback hooks, restarts workloads so restored Secrets and ConfigMaps are reloaded, and checks readiness in the background.
            </span>
            <Alert severity="warning">
              Kubernetes rollback does not restore persistent data or reverse database migrations. Confirm the chart vendor supports rollback and that you have a
              usable backup; otherwise follow the application’s recovery procedure instead.
            </Alert>
          </Stack>
        }
        onClose={() => setRollbackTo(null)}
        onConfirm={() =>
          rollback.mutate(
            { ctx: ctx!, ns: ns!, name: name!, revision: rollbackTo! },
            {
              onSuccess: () => {
                setRollbackTo(null);
                setOperationError(undefined);
                showToast('info', `Rollback to revision ${rollbackTo} started. Progress is shown on this page.`);
              },
              onError: (e) => {
                setRollbackTo(null);
                setOperationError(e);
                showToast('error', 'Rollback failed — review the recovery details on this page');
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
