import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import SyncIcon from '@mui/icons-material/Sync';
import { AgeCell } from '../../AgeCell.js';
import { StatusChip } from '../../StatusChip.js';
import { ClampedText } from '../ClampedText.js';
import { CustomResourceFooter } from '../CustomResourceDetail.js';
import { Fact, FactLink, Facts, WarnValue } from '../Facts.js';
import { safeHref } from '../GenericDetail.js';
import { ProblemBanner } from '../ProblemBanner.js';
import { DetailStack, Section } from '../Section.js';
import { SummaryStrip } from '../SummaryStrip.js';
import { HEALTH_TONE, SYNC_TONE, appDeploysInCluster, appProblems, appSources, appSyncPolicy, shortRevision, sortedResources, type AppSpec, type AppStatus } from './argo-cd.js';
import { useObjectOpener } from './links.js';
import { OperatorActionButtons } from './OperatorActionButtons.js';
import type { CustomKindActionProps, CustomKindViewProps } from './registry.js';

function OnOff({ on, onText = 'On', offText = 'Off' }: { on: boolean; onText?: string; offText?: string }) {
  return on ? (
    <>{onText}</>
  ) : (
    <Box component="span" sx={{ color: 'text.secondary' }}>
      {offText}
    </Box>
  );
}

/**
 * Argo CD Application: sync and health up top, what it deploys from where,
 * the sync policy flags, the last operation, and every managed resource
 * with its own sync and health, problems first.
 */
export function ArgoApplicationDetail({ obj, ctx, crd, version }: CustomKindViewProps) {
  const open = useObjectOpener(ctx);
  const spec = (obj.spec ?? {}) as AppSpec;
  const status = (obj.status ?? {}) as AppStatus;
  const policy = appSyncPolicy(obj);
  const sources = appSources(obj);
  const problems = useMemo(() => appProblems(obj), [obj]);
  const resources = useMemo(() => sortedResources(obj), [obj]);
  const syncStatus = status.sync?.status;
  const health = status.health?.status;
  const revisions = status.sync?.revisions?.length ? status.sync.revisions : status.sync?.revision ? [status.sync.revision] : [];
  const op = status.operationState;
  const projectOpener = spec.project ? open({ group: 'argoproj.io', kind: 'AppProject', name: spec.project, namespace: obj.metadata.namespace }) : undefined;
  const destination = spec.destination;
  // Managed resources link into this cluster only when the app deploys here.
  const inCluster = appDeploysInCluster(obj);
  const destinationLabel = destination?.name ?? destination?.server;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Sync', value: syncStatus ?? '—', tone: SYNC_TONE[syncStatus ?? ''] },
          { label: 'Health', value: health ?? '—', tone: HEALTH_TONE[health ?? ''] },
          { label: 'Revision', value: revisions.map(shortRevision).join(', ') || '—', mono: true, title: revisions.join(', ') },
          { label: 'Resources', value: String(resources.length) },
          !!op?.finishedAt && { label: 'Last sync', value: <><AgeCell timestamp={op.finishedAt} variant="inherit" /> ago</>, hint: 'When the last sync operation finished.' },
        ]}
      />
      {problems.length > 0 && <ProblemBanner severity={health === 'Degraded' || op?.phase === 'Failed' || op?.phase === 'Error' ? 'error' : 'warning'} title="What needs attention" items={problems} />}
      <Section title={sources.length > 1 ? 'Sources' : 'Source'} count={sources.length > 1 ? sources.length : undefined}>
        {sources.map((source, i) => {
          const href = source.repoURL ? safeHref(source.repoURL) : undefined;
          return (
            <Box key={i} sx={{ pt: i === 0 ? 0 : 1.25, mt: i === 0 ? 0 : 1.25, borderTop: i === 0 ? 0 : 1, borderColor: 'divider' }}>
              <Facts>
                <Fact label="Repository" mono>
                  {source.repoURL &&
                    (href ? (
                      <Link href={href} target="_blank" rel="noopener noreferrer" underline="hover" sx={{ fontFamily: 'inherit', wordBreak: 'break-all' }}>
                        {source.repoURL}
                      </Link>
                    ) : (
                      source.repoURL
                    ))}
                </Fact>
                <Fact label={source.chart ? 'Chart' : 'Path'} mono>
                  {source.chart ?? source.path ?? '.'}
                </Fact>
                <Fact label="Target revision" mono>
                  {source.targetRevision || 'HEAD'}
                </Fact>
                <Fact label="Ref" mono>
                  {source.ref}
                </Fact>
                <Fact label="Synced revision" mono>
                  {revisions[i]}
                </Fact>
              </Facts>
            </Box>
          );
        })}
        {sources.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No source configured.
          </Typography>
        )}
      </Section>
      <Section title="Sync policy" description={policy.auto ? 'automated' : 'manual'}>
        <Facts>
          <Fact label="Auto-sync" hint="Argo CD syncs by itself whenever the live state drifts from Git.">
            <OnOff on={policy.auto} offText="Off (manual sync)" />
          </Fact>
          <Fact label="Prune" hint="Automated syncs delete resources that were removed from Git.">
            <OnOff on={policy.prune} />
          </Fact>
          <Fact label="Self-heal" hint="Automated syncs also undo changes made in the cluster.">
            <OnOff on={policy.selfHeal} />
          </Fact>
          <Fact label="Options" mono>
            {policy.options.join(', ') || undefined}
          </Fact>
          <Fact label="Project">{spec.project && (projectOpener ? <FactLink onClick={projectOpener}>{spec.project}</FactLink> : spec.project)}</Fact>
          <Fact label="Destination" mono>
            {destination && [destination.name ?? destination.server, destination.namespace].filter(Boolean).join(' · ')}
          </Fact>
        </Facts>
      </Section>
      {op && (
        <Section title="Last operation" description={op.phase}>
          <Facts>
            <Fact label="Phase">{op.phase && <StatusChip status={op.phase === 'Succeeded' ? 'Succeeded' : op.phase === 'Running' ? 'Progressing' : op.phase} label={op.phase} />}</Fact>
            <Fact label="Started">{op.startedAt && <><AgeCell timestamp={op.startedAt} /> ago</>}</Fact>
            <Fact label="Finished">{op.finishedAt && <><AgeCell timestamp={op.finishedAt} /> ago</>}</Fact>
            <Fact label="Initiated by">{op.operation?.initiatedBy?.automated ? 'automated sync' : op.operation?.initiatedBy?.username}</Fact>
            <Fact label="Revision" mono>
              {op.syncResult?.revision ?? op.operation?.sync?.revision}
            </Fact>
            <Fact label="Pruned">{op.operation?.sync?.prune ? <WarnValue>Yes</WarnValue> : undefined}</Fact>
            <Fact label="Message">{op.message && <ClampedText text={op.message} lines={4} />}</Fact>
          </Facts>
        </Section>
      )}
      <Section title="Resources" count={resources.length} flush description={inCluster || !destinationLabel ? undefined : `in ${destinationLabel}`}>
        {resources.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            Argo CD has not reported any managed resources yet.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Resource</TableCell>
                <TableCell>Sync</TableCell>
                <TableCell>Health</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {resources.map((r) => {
                const opener = inCluster ? open({ group: r.group ?? '', kind: r.kind, name: r.name, namespace: r.namespace }) : undefined;
                const label = `${r.namespace ? `${r.namespace}/` : ''}${r.name}`;
                return (
                  <TableRow key={`${r.group}/${r.kind}/${r.namespace}/${r.name}`} sx={{ verticalAlign: 'top' }}>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {r.kind}
                      </Typography>
                      {opener ? <FactLink onClick={opener}>{label}</FactLink> : label}
                      {r.health?.message && (r.health.status === 'Degraded' || r.health.status === 'Missing') && (
                        <ClampedText text={r.health.message} lines={2} sx={{ mt: 0.25, color: 'text.secondary', fontSize: 12.5 }} />
                      )}
                    </TableCell>
                    <TableCell>{r.status ? <StatusChip status={r.status === 'OutOfSync' ? 'Warning' : r.status} label={r.status} /> : '—'}</TableCell>
                    <TableCell>{r.health?.status ? <StatusChip status={r.health.status} /> : <Typography variant="body2" color="text.secondary">—</Typography>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
      <CustomResourceFooter obj={obj} ctx={ctx} crd={crd} version={version} />
    </DetailStack>
  );
}

/** Refresh (re-read Git now) and Sync (apply it), the two things people open an Application for. */
export function ArgoApplicationActions(props: CustomKindActionProps) {
  const [prune, setPrune] = useState(false);
  const name = props.obj.metadata.name;
  const policy = appSyncPolicy(props.obj);
  const revision = appSources(props.obj)
    .map((s) => s.targetRevision || 'HEAD')
    .join(', ');
  return (
    <OperatorActionButtons
      target={props}
      actions={[
        {
          action: 'argocd-sync',
          label: 'Sync',
          icon: <SyncIcon />,
          emphasis: true,
          done: `Sync started for ${name}`,
          body: { prune },
          onOpen: () => setPrune(false),
          confirm: {
            title: `Sync ${name}`,
            confirmLabel: prune ? 'Sync and prune' : 'Sync',
            danger: prune,
            message: (
              <>
                Apply <b>{revision || 'HEAD'}</b> to the cluster now{policy.auto ? ' (auto-sync would do this on its own)' : ''}.
                <FormControlLabel
                  sx={{ display: 'flex', mt: 1.5 }}
                  control={<Checkbox size="small" checked={prune} onChange={(e) => setPrune(e.target.checked)} />}
                  label="Prune: delete resources that are no longer in the source"
                />
              </>
            ),
          },
        },
        { action: 'argocd-refresh', label: 'Refresh', icon: <RefreshIcon />, done: `Refresh requested for ${name}` },
      ]}
    />
  );
}
