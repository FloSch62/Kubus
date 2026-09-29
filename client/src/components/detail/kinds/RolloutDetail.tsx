import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import PlayCircleFilledIcon from '@mui/icons-material/PlayCircleFilled';
import FastForwardIcon from '@mui/icons-material/FastForward';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import ReplayIcon from '@mui/icons-material/Replay';
import type { KubeObject } from '@kubus/shared';
import { DETAIL_LIST_LIVE_MS, useResourceList } from '../../../api/queries.js';
import { statusTextColor } from '../../../theme.js';
import { AgeCell } from '../../AgeCell.js';
import { ConditionRows } from '../GenericDetail.js';
import { CustomResourceFooter } from '../CustomResourceDetail.js';
import { Fact, FactLink, Facts, WarnValue } from '../Facts.js';
import { conditionHealthy, conditionList } from '../nested-conditions.js';
import { ProblemBanner, type ProblemItem } from '../ProblemBanner.js';
import { CountPill, DetailStack, Section } from '../Section.js';
import { SummaryStrip, type SummaryTone } from '../SummaryStrip.js';
import {
  ROLLOUT_HASH_LABEL,
  canaryWeight,
  describeStep,
  imageRows,
  rolloutActions,
  rolloutState,
  rolloutStrategy,
  stepState,
  type RolloutSpec,
  type RolloutStatus,
} from './argo-rollouts.js';
import { useObjectOpener } from './links.js';
import { OperatorActionButtons, type OperatorActionSpec } from './OperatorActionButtons.js';
import type { CustomKindActionProps, CustomKindViewProps } from './registry.js';

const PHASE_TONE: Record<string, SummaryTone> = { Healthy: 'success', Progressing: 'info', Paused: 'warning', Degraded: 'error' };

// Paused and InvalidSpec are the Rollout conditions that are bad when True.
const rolloutGoodWhen = (type: string): 'True' | 'False' => (type === 'Paused' || type === 'InvalidSpec' ? 'False' : 'True');

function rolloutProblems(ro: KubeObject): ProblemItem[] {
  const status = (ro.status ?? {}) as RolloutStatus;
  const items: ProblemItem[] = [];
  if (status.abort) items.push({ title: 'Update aborted', message: status.message || 'Traffic is back on the stable revision. Retry to roll the new revision out again.', at: status.abortedAt });
  else if (status.phase === 'Degraded') items.push({ title: 'Degraded', message: status.message });
  const analysis = status.canary?.currentStepAnalysisRunStatus;
  if (analysis && ['Failed', 'Error', 'Inconclusive'].includes(analysis.status ?? '')) {
    items.push({ title: `Analysis ${analysis.name ?? ''} ${analysis.status}`.replace(/\s+/g, ' '), message: analysis.message });
  }
  return items;
}

interface ReplicaSetShape {
  metadata: KubeObject['metadata'];
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ name: string; image?: string }> } } };
  status?: { readyReplicas?: number; replicas?: number };
}

/**
 * Argo Rollout: the strategy and where the update stands (the canary step
 * list with the current step marked, traffic weight, stable against canary
 * images), with Promote and Abort in the action bar.
 */
export function RolloutDetail({ obj, ctx, crd, version }: CustomKindViewProps) {
  const open = useObjectOpener(ctx);
  const namespace = obj.metadata.namespace;
  const spec = (obj.spec ?? {}) as RolloutSpec;
  const status = (obj.status ?? {}) as RolloutStatus;
  const strategy = rolloutStrategy(spec);
  const state = rolloutState(obj);
  const steps = spec.strategy?.canary?.steps ?? [];
  const weight = canaryWeight(obj);
  const labelSelector = Object.entries(spec.selector?.matchLabels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const rsQuery = useResourceList(namespace && labelSelector ? { ctx, group: 'apps', version: 'v1', plural: 'replicasets', namespace, labelSelector } : undefined, { liveMs: DETAIL_LIST_LIVE_MS });
  const byHash = useMemo(() => {
    const map = new Map<string, ReplicaSetShape>();
    for (const rs of (rsQuery.data?.items ?? []) as ReplicaSetShape[]) {
      const hash = rs.metadata.labels?.[ROLLOUT_HASH_LABEL];
      if (hash) map.set(hash, rs);
    }
    return map;
  }, [rsQuery.data?.items]);
  const stableRs = status.stableRS ? byHash.get(status.stableRS) : undefined;
  const newRs = status.currentPodHash ? byHash.get(status.currentPodHash) : undefined;
  // The desired template is the new revision even before its ReplicaSet exists.
  const images = imageRows(stableRs?.spec?.template?.spec?.containers, newRs?.spec?.template?.spec?.containers ?? spec.template?.spec?.containers);
  const problems = useMemo(() => rolloutProblems(obj), [obj]);
  const conditions = conditionList((obj.status as { conditions?: unknown } | undefined)?.conditions) ?? [];
  const desired = spec.replicas ?? 1;
  const ready = status.readyReplicas ?? 0;
  const pause = status.pauseConditions?.[0];
  const newLabel = strategy === 'BlueGreen' ? 'Preview' : 'Canary';
  const currentStep = status.currentStepIndex;

  const workload = spec.workloadRef;
  const workloadOpener = workload?.name && workload.kind ? open({ group: workload.apiVersion?.split('/')[0] ?? 'apps', kind: workload.kind, name: workload.name, namespace }) : undefined;
  const serviceLink = (name: string | undefined) => {
    if (!name) return undefined;
    const opener = open({ group: '', kind: 'Service', name, namespace });
    return opener ? <FactLink onClick={opener}>{name}</FactLink> : name;
  };

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Phase', value: status.abort ? 'Aborted' : (status.phase ?? '—'), tone: status.abort ? 'error' : PHASE_TONE[status.phase ?? ''] },
          { label: 'Strategy', value: strategy ?? '—' },
          strategy === 'Canary' && steps.length > 0 && { label: 'Steps done', value: `${Math.min(currentStep ?? steps.length, steps.length)}/${steps.length}`, hint: 'Canary steps completed.' },
          weight !== undefined && { label: 'Canary weight', value: `${weight}%`, hint: 'Share of traffic sent to the new revision.' },
          { label: 'Ready', value: `${ready}/${desired}`, tone: ready >= desired ? 'success' : ready === 0 ? 'error' : 'warning' },
        ]}
      />
      {problems.length > 0 && <ProblemBanner severity={status.abort || status.phase === 'Degraded' ? 'error' : 'warning'} title="Why this rollout isn’t progressing" items={problems} />}
      {!status.abort && state.paused && (
        <Alert severity="info" variant="outlined" sx={{ alignItems: 'center' }}>
          <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
            Paused{currentStep !== undefined && strategy === 'Canary' ? ` at step ${Math.min(currentStep + 1, steps.length)}` : ''}
          </Typography>
          <Typography variant="body2" component="span" color="text.secondary">
            {(pause?.reason || pause?.startTime) && (
              <>
                {' ('}
                {pause.reason}
                {pause.reason && pause.startTime ? ', ' : ''}
                {pause.startTime && (
                  <>
                    <AgeCell timestamp={pause.startTime} /> ago
                  </>
                )}
                {')'}
              </>
            )}
            . Promote to continue.
          </Typography>
        </Alert>
      )}
      {strategy === 'Canary' && (
        <Section title="Steps" count={steps.length} flush description={state.updating ? `on step ${Math.min((currentStep ?? 0) + 1, steps.length)}` : 'all steps complete'}>
          {steps.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
              No steps: a new revision is promoted as soon as it is ready.
            </Typography>
          ) : (
            <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none' }}>
              {steps.map((step, i) => {
                const s = stepState(i, obj);
                const { title, detail } = describeStep(step);
                return (
                  <Stack
                    component="li"
                    key={i}
                    direction="row"
                    aria-current={s === 'current' ? 'step' : undefined}
                    sx={{
                      alignItems: 'center',
                      gap: 1,
                      px: 1.5,
                      py: 0.625,
                      borderTop: i === 0 ? 0 : 1,
                      borderColor: 'divider',
                      bgcolor: s === 'current' ? 'action.selected' : undefined,
                    }}
                  >
                    {s === 'done' ? (
                      <CheckCircleIcon sx={{ fontSize: 16, color: statusTextColor('success') }} />
                    ) : s === 'current' ? (
                      <PlayCircleFilledIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                    ) : (
                      <RadioButtonUncheckedIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                    )}
                    <Typography variant="body2" color="text.secondary" sx={{ width: 18, textAlign: 'right', flexShrink: 0 }}>
                      {i + 1}
                    </Typography>
                    <Typography variant="body2" sx={{ fontWeight: s === 'current' ? 600 : 400, color: s === 'pending' ? 'text.secondary' : 'text.primary' }}>
                      {title}
                    </Typography>
                    {detail && (
                      <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 12.5, wordBreak: 'break-word', minWidth: 0 }}>
                        {detail}
                      </Typography>
                    )}
                    {s === 'current' && <CountPill value="current" sx={{ ml: 'auto', color: 'primary.main' }} />}
                  </Stack>
                );
              })}
            </Box>
          )}
        </Section>
      )}
      <Section title="Revisions" flush description={state.updating ? `stable ${status.stableRS ?? '?'} → ${newLabel.toLowerCase()} ${status.currentPodHash ?? '?'}` : status.stableRS ? `stable ${status.stableRS}` : undefined}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Container</TableCell>
              <TableCell>Stable</TableCell>
              <TableCell>{newLabel}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {images.map((row) => (
              <TableRow key={row.container} sx={{ verticalAlign: 'top' }}>
                <TableCell sx={{ fontWeight: 600, wordBreak: 'break-word' }}>{row.container}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12.5, wordBreak: 'break-all' }}>{row.stable ?? '—'}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12.5, wordBreak: 'break-all' }}>
                  {!state.updating && !row.changed ? (
                    <Box component="span" sx={{ color: 'text.secondary', fontFamily: 'inherit' }}>
                      same as stable
                    </Box>
                  ) : (
                    <Box component="span" sx={{ fontFamily: 'inherit', fontWeight: row.changed ? 600 : 400, color: row.changed ? statusTextColor('info') : 'inherit' }}>
                      {row.canary ?? '—'}
                    </Box>
                  )}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell sx={{ color: 'text.secondary' }}>Pods ready</TableCell>
              <TableCell>{stableRs ? `${stableRs.status?.readyReplicas ?? 0}/${stableRs.spec?.replicas ?? 0}` : '—'}</TableCell>
              <TableCell>{state.updating && newRs ? `${newRs.status?.readyReplicas ?? 0}/${newRs.spec?.replicas ?? 0}` : '—'}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>
      <Section title="Details">
        <Facts>
          {strategy === 'Canary' && <Fact label="Canary service">{serviceLink(spec.strategy?.canary?.canaryService)}</Fact>}
          {strategy === 'Canary' && <Fact label="Stable service">{serviceLink(spec.strategy?.canary?.stableService)}</Fact>}
          {strategy === 'Canary' && (
            <Fact label="Traffic routing" hint="Without a traffic router, the weight is approximated by the ratio of canary to stable pods.">
              {Object.keys(spec.strategy?.canary?.trafficRouting ?? {}).join(', ') || 'replica ratio'}
            </Fact>
          )}
          {strategy === 'BlueGreen' && <Fact label="Active service">{serviceLink(spec.strategy?.blueGreen?.activeService)}</Fact>}
          {strategy === 'BlueGreen' && <Fact label="Preview service">{serviceLink(spec.strategy?.blueGreen?.previewService)}</Fact>}
          {strategy === 'BlueGreen' && (
            <Fact label="Auto-promotion">
              {spec.strategy?.blueGreen?.autoPromotionEnabled === false ? 'Off' : spec.strategy?.blueGreen?.autoPromotionSeconds ? `after ${spec.strategy.blueGreen.autoPromotionSeconds}s` : 'On'}
            </Fact>
          )}
          <Fact label="Workload">{workload?.name && (workloadOpener ? <FactLink onClick={workloadOpener}>{`${workload.kind} ${workload.name}`}</FactLink> : `${workload.kind} ${workload.name}`)}</Fact>
          <Fact label="Selector" mono>
            {labelSelector || undefined}
          </Fact>
          <Fact label="Paused by hand" hint="spec.paused is set: the rollout does not progress until it is promoted.">
            {spec.paused && <WarnValue>Yes</WarnValue>}
          </Fact>
          <Fact label="Message">{status.message}</Fact>
        </Facts>
      </Section>
      {conditions.length > 0 && (
        <Section title="Conditions" count={conditions.length} flush defaultOpen={conditions.some((c) => !conditionHealthy(c, rolloutGoodWhen))}>
          <ConditionRows conditions={conditions} goodWhen={rolloutGoodWhen} />
        </Section>
      )}
      <CustomResourceFooter obj={obj} ctx={ctx} crd={crd} version={version} />
    </DetailStack>
  );
}

/** Promote, Promote full, Abort and Retry, offered only when they apply. */
export function RolloutActions(props: CustomKindActionProps) {
  const { obj } = props;
  const name = obj.metadata.name;
  const available = rolloutActions(obj);
  const bluegreen = rolloutStrategy(obj.spec as RolloutSpec | undefined) === 'BlueGreen';
  const actions: OperatorActionSpec[] = [];
  if (available.promote) {
    actions.push({
      action: 'rollout-promote',
      label: 'Promote',
      icon: <SkipNextIcon />,
      emphasis: true,
      done: `Promoted ${name}`,
      confirm: {
        title: `Promote ${name}`,
        message: bluegreen ? 'Switch the active service to the preview revision.' : 'Resume the canary: clear the current pause and continue with the next step.',
        confirmLabel: 'Promote',
      },
    });
  }
  if (available.promoteFull) {
    actions.push({
      action: 'rollout-promote-full',
      label: 'Promote full',
      icon: <FastForwardIcon />,
      done: `Fully promoting ${name}`,
      confirm: {
        title: `Promote ${name} fully`,
        message: 'Skip every remaining step, analysis and pause, and make the new revision stable now.',
        confirmLabel: 'Promote full',
        danger: true,
      },
    });
  }
  if (available.abort) {
    actions.push({
      action: 'rollout-abort',
      label: 'Abort',
      icon: <CancelOutlinedIcon />,
      done: `Aborted ${name}`,
      confirm: {
        title: `Abort ${name}`,
        message: 'Send all traffic back to the stable revision and scale the new one down. The update stays aborted until you retry it.',
        confirmLabel: 'Abort',
        danger: true,
      },
    });
  }
  if (available.retry) {
    actions.push({
      action: 'rollout-retry',
      label: 'Retry',
      icon: <ReplayIcon />,
      emphasis: true,
      done: `Retrying ${name}`,
      confirm: { title: `Retry ${name}`, message: 'Start the aborted update again from its first step.', confirmLabel: 'Retry' },
    });
  }
  if (!actions.length) return null;
  return <OperatorActionButtons target={props} actions={actions} />;
}
