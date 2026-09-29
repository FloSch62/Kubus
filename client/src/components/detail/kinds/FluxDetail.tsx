import Alert from '@mui/material/Alert';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import SyncIcon from '@mui/icons-material/Sync';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import type { KubeObject } from '@kubus/shared';
import { appNavigate } from '../../../app-navigate.js';
import { AgeCell } from '../../AgeCell.js';
import { StatusChip } from '../../StatusChip.js';
import { ConditionRows } from '../GenericDetail.js';
import { CustomResourceFooter } from '../CustomResourceDetail.js';
import { Fact, FactLink, Facts, WarnValue } from '../Facts.js';
import { conditionHealthy } from '../nested-conditions.js';
import { ProblemBanner, type ProblemItem } from '../ProblemBanner.js';
import { DetailStack, Section } from '../Section.js';
import { SummaryStrip, type SummaryItem } from '../SummaryStrip.js';
import { fluxConditions, fluxGoodWhen, fluxSuspended, inventory } from './flux.js';
import { useObjectOpener } from './links.js';
import { conditionTile } from './tiles.js';
import { OperatorActionButtons } from './OperatorActionButtons.js';
import type { CustomKindActionProps, CustomKindViewProps } from './registry.js';

interface SourceRef {
  apiVersion?: string;
  kind?: string;
  name?: string;
  namespace?: string;
}

const SOURCE_GROUP = 'source.toolkit.fluxcd.io';

/** Flux revisions read `main@sha1:<sha>`; show the branch and short sha. */
function fluxRevision(revision: string | undefined): string | undefined {
  if (!revision) return undefined;
  const m = /^(.*?)@?(sha1|sha256):([0-9a-f]+)$/.exec(revision);
  if (!m) return revision;
  return `${m[1] ? `${m[1]}@` : ''}${m[3]!.slice(0, 7)}`;
}

function readyItem(obj: KubeObject): SummaryItem {
  return conditionTile('Ready', fluxConditions(obj).find((c) => c.type === 'Ready'));
}

function fluxProblems(obj: KubeObject): ProblemItem[] {
  return fluxConditions(obj)
    .filter((c) => (c.type === 'Ready' && c.status === 'False') || (c.type === 'Stalled' && c.status === 'True'))
    .map((c) => ({ title: `${c.type === 'Ready' ? 'Not ready' : 'Stalled'}${c.reason ? `: ${c.reason}` : ''}`, message: c.message, at: c.lastTransitionTime }));
}

/** Problems, the suspended notice, and the conditions card every Flux view shares. */
function FluxStatus({ obj, kind }: { obj: KubeObject; kind: string }) {
  const problems = fluxProblems(obj);
  return (
    <>
      {problems.length > 0 && <ProblemBanner severity="error" title={`Why this ${kind} isn’t ready`} items={problems} />}
      {fluxSuspended(obj) && (
        <Alert severity="warning" variant="outlined">
          Reconciliation is suspended. Flux leaves this {kind} alone until you resume it.
        </Alert>
      )}
    </>
  );
}

function FluxConditions({ obj }: { obj: KubeObject }) {
  const conditions = fluxConditions(obj);
  if (!conditions.length) return null;
  return (
    <Section title="Conditions" count={conditions.length} flush defaultOpen={conditions.some((c) => !conditionHealthy(c, fluxGoodWhen))}>
      <ConditionRows conditions={conditions} goodWhen={fluxGoodWhen} />
    </Section>
  );
}

function useSourceLink(ctx: string, ref: SourceRef | undefined, namespace: string | undefined) {
  const open = useObjectOpener(ctx);
  if (!ref?.name || !ref.kind) return undefined;
  const group = ref.apiVersion?.split('/')[0] ?? SOURCE_GROUP;
  const opener = open({ group, kind: ref.kind, name: ref.name, namespace: ref.namespace ?? namespace });
  const text = `${ref.kind} ${ref.namespace && ref.namespace !== namespace ? `${ref.namespace}/` : ''}${ref.name}`;
  return opener ? <FactLink onClick={opener}>{text}</FactLink> : text;
}

interface KustomizationSpec {
  interval?: string;
  path?: string;
  prune?: boolean;
  sourceRef?: SourceRef;
  targetNamespace?: string;
  dependsOn?: Array<{ name: string; namespace?: string }>;
  timeout?: string;
  wait?: boolean;
  force?: boolean;
  serviceAccountName?: string;
}

/**
 * Flux Kustomization: ready state and the revision it last applied, where
 * that comes from, and the objects it manages (its inventory), each a link.
 */
export function KustomizationDetail({ obj, ctx, crd, version }: CustomKindViewProps) {
  const open = useObjectOpener(ctx);
  const namespace = obj.metadata.namespace;
  const spec = (obj.spec ?? {}) as KustomizationSpec;
  const status = (obj.status ?? {}) as { lastAppliedRevision?: string; lastAttemptedRevision?: string; lastHandledReconcileAt?: string };
  const entries = inventory(obj);
  const source = useSourceLink(ctx, spec.sourceRef, namespace);
  const attemptedDiffers = !!status.lastAttemptedRevision && status.lastAttemptedRevision !== status.lastAppliedRevision;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          readyItem(obj),
          { label: 'Applied', value: fluxRevision(status.lastAppliedRevision) ?? '—', mono: true, title: status.lastAppliedRevision, hint: 'Last revision applied to the cluster.' },
          { label: 'Objects', value: String(entries.length), hint: 'Objects in the inventory, which prune deletes when they leave the source.' },
          { label: 'Interval', value: spec.interval ?? '—' },
        ]}
      />
      <FluxStatus obj={obj} kind="Kustomization" />
      <Section title="Source">
        <Facts>
          <Fact label="Source">{source}</Fact>
          <Fact label="Path" mono>
            {spec.path ?? './'}
          </Fact>
          <Fact label="Applied revision" mono>
            {status.lastAppliedRevision}
          </Fact>
          <Fact label="Attempted revision" mono hint="The revision of the last try, when it differs from the one applied.">
            {attemptedDiffers && <WarnValue>{status.lastAttemptedRevision!}</WarnValue>}
          </Fact>
          <Fact label="Prune">{spec.prune ? 'On' : 'Off'}</Fact>
          <Fact label="Target namespace">{spec.targetNamespace}</Fact>
          <Fact label="Depends on">
            {spec.dependsOn?.length
              ? spec.dependsOn.map((d, i) => {
                  const opener = open({ group: obj.apiVersion?.split('/')[0] ?? 'kustomize.toolkit.fluxcd.io', kind: 'Kustomization', name: d.name, namespace: d.namespace ?? namespace });
                  return (
                    <span key={d.name}>
                      {i > 0 && ', '}
                      {opener ? <FactLink onClick={opener}>{d.name}</FactLink> : d.name}
                    </span>
                  );
                })
              : undefined}
          </Fact>
          <Fact label="Service account">{spec.serviceAccountName}</Fact>
          <Fact label="Wait / timeout">{[spec.wait ? 'wait for readiness' : undefined, spec.timeout && `timeout ${spec.timeout}`].filter(Boolean).join(' · ') || undefined}</Fact>
          <Fact label="Suspended">{fluxSuspended(obj) && <WarnValue>Yes</WarnValue>}</Fact>
        </Facts>
      </Section>
      <Section title="Inventory" count={entries.length} flush defaultOpen={entries.length > 0 && entries.length <= 50}>
        {entries.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            No inventory yet: nothing has been applied.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Kind</TableCell>
                <TableCell>Object</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((e) => {
                const opener = open({ group: e.group, kind: e.kind, name: e.name, namespace: e.namespace });
                const label = `${e.namespace ? `${e.namespace}/` : ''}${e.name}`;
                return (
                  <TableRow key={`${e.group}/${e.kind}/${e.namespace}/${e.name}`}>
                    <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>{e.kind}</TableCell>
                    <TableCell sx={{ wordBreak: 'break-word' }}>{opener ? <FactLink onClick={opener}>{label}</FactLink> : label}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
      <FluxConditions obj={obj} />
      <CustomResourceFooter obj={obj} ctx={ctx} crd={crd} version={version} />
    </DetailStack>
  );
}

interface HelmReleaseSpec {
  interval?: string;
  releaseName?: string;
  targetNamespace?: string;
  storageNamespace?: string;
  chart?: { spec?: { chart?: string; version?: string; sourceRef?: SourceRef } };
  chartRef?: SourceRef;
}

interface HelmHistoryEntry {
  name?: string;
  namespace?: string;
  version?: number;
  status?: string;
  chartName?: string;
  chartVersion?: string;
  appVersion?: string;
  firstDeployed?: string;
  lastDeployed?: string;
}

interface HelmReleaseStatus {
  history?: HelmHistoryEntry[];
  lastAttemptedRevision?: string;
  lastAttemptedReleaseAction?: string;
  installFailures?: number;
  upgradeFailures?: number;
  storageNamespace?: string;
}

/**
 * Flux HelmRelease: ready state, the chart and version it installed, the
 * Helm release it manages (with a link to Kubus's release page), and the
 * release history Flux keeps.
 */
export function HelmReleaseDetail({ obj, ctx, crd, version }: CustomKindViewProps) {
  const namespace = obj.metadata.namespace;
  const spec = (obj.spec ?? {}) as HelmReleaseSpec;
  const status = (obj.status ?? {}) as HelmReleaseStatus;
  const history = status.history ?? [];
  const latest = history[0];
  const chartSpec = spec.chart?.spec;
  const source = useSourceLink(ctx, chartSpec?.sourceRef ?? spec.chartRef, namespace);
  const releaseName = latest?.name ?? spec.releaseName ?? (spec.targetNamespace ? `${spec.targetNamespace}-${obj.metadata.name}` : obj.metadata.name);
  const storageNamespace = latest?.namespace ?? status.storageNamespace ?? spec.storageNamespace ?? namespace;
  const chart = latest?.chartName ?? chartSpec?.chart;
  const failures = (status.installFailures ?? 0) + (status.upgradeFailures ?? 0);

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          readyItem(obj),
          { label: 'Chart', value: chart ? `${chart}${latest?.chartVersion ? `@${latest.chartVersion}` : ''}` : '—', mono: true, span: 2 },
          { label: 'Release', value: latest?.version !== undefined ? `v${latest.version}` : '—', hint: 'Helm release revision.' },
          !!latest?.appVersion && { label: 'App version', value: latest.appVersion, mono: true },
        ]}
      />
      <FluxStatus obj={obj} kind="HelmRelease" />
      <Section title="Chart">
        <Facts>
          <Fact label="Chart" mono>
            {chart}
          </Fact>
          <Fact label="Version" mono hint="The version constraint in the spec; the history shows what was installed.">
            {chartSpec?.version ?? (spec.chartRef ? 'set by the chart source' : '*')}
          </Fact>
          <Fact label="Source">{source}</Fact>
          <Fact label="Helm release">
            {latest && storageNamespace ? (
              <FactLink onClick={() => appNavigate(`/helm/${encodeURIComponent(ctx)}/${encodeURIComponent(storageNamespace)}/${encodeURIComponent(releaseName)}`)}>
                {`${storageNamespace}/${releaseName}`}
              </FactLink>
            ) : (
              releaseName
            )}
          </Fact>
          <Fact label="Target namespace">{spec.targetNamespace}</Fact>
          <Fact label="Interval">{spec.interval}</Fact>
          <Fact label="Last attempt" mono>
            {[status.lastAttemptedReleaseAction, status.lastAttemptedRevision].filter(Boolean).join(' ') || undefined}
          </Fact>
          <Fact label="Failures" hint="Install and upgrade failures since the last success; remediation retries count against these.">
            {failures > 0 && <WarnValue>{`${status.installFailures ?? 0} install · ${status.upgradeFailures ?? 0} upgrade`}</WarnValue>}
          </Fact>
          <Fact label="Suspended">{fluxSuspended(obj) && <WarnValue>Yes</WarnValue>}</Fact>
        </Facts>
      </Section>
      <Section title="History" count={history.length} flush defaultOpen={history.length > 0}>
        {history.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            Not installed yet.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Revision</TableCell>
                <TableCell>Chart</TableCell>
                <TableCell>App</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Deployed</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {history.map((h, i) => (
                <TableRow key={`${h.version}:${i}`}>
                  <TableCell>{h.version ?? '—'}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12.5, wordBreak: 'break-all' }}>{[h.chartName, h.chartVersion].filter(Boolean).join('@') || '—'}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12.5 }}>{h.appVersion ?? '—'}</TableCell>
                  <TableCell>{h.status ? <StatusChip status={h.status} /> : '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{h.lastDeployed ? <><AgeCell timestamp={h.lastDeployed} /> ago</> : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      <FluxConditions obj={obj} />
      <CustomResourceFooter obj={obj} ctx={ctx} crd={crd} version={version} />
    </DetailStack>
  );
}

/** Reconcile now, and Suspend or Resume, for any Flux object. */
export function FluxActions(props: CustomKindActionProps) {
  const name = props.obj.metadata.name;
  const kind = props.obj.kind ?? 'object';
  const suspended = fluxSuspended(props.obj);
  return (
    <OperatorActionButtons
      target={props}
      actions={[
        { action: 'flux-reconcile', label: 'Reconcile', icon: <SyncIcon />, emphasis: true, done: `Reconcile requested for ${name}` },
        suspended
          ? {
              action: 'flux-resume',
              label: 'Resume',
              icon: <PlayCircleOutlinedIcon />,
              done: `Resumed ${name}`,
              confirm: { title: `Resume ${name}`, message: `Let Flux reconcile this ${kind} again, starting now.`, confirmLabel: 'Resume' },
            }
          : {
              action: 'flux-suspend',
              label: 'Suspend',
              icon: <PauseCircleOutlinedIcon />,
              done: `Suspended ${name}`,
              confirm: {
                title: `Suspend ${name}`,
                message: `Stop Flux from reconciling this ${kind}. Changes in the source, and drift in the cluster, are ignored until you resume it.`,
                confirmLabel: 'Suspend',
              },
            },
      ]}
    />
  );
}
