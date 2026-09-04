import Box from '@mui/material/Box';
import type { KubeObject } from '@kubus/shared';
import { DETAIL_LIST_LIVE_MS, useResourceList } from '../../api/queries.js';
import { ConditionsTable, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { Fact, Facts } from './Facts.js';
import { PodMiniList } from './PodMiniList.js';
import { ProblemBanner } from './ProblemBanner.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';
import { labelSelectorToString, type LabelSelector } from './selectors.js';

interface PdbSpec {
  minAvailable?: number | string;
  maxUnavailable?: number | string;
  selector?: LabelSelector;
  unhealthyPodEvictionPolicy?: string;
}

interface PdbStatus {
  currentHealthy?: number;
  desiredHealthy?: number;
  disruptionsAllowed?: number;
  expectedPods?: number;
  observedGeneration?: number;
  disruptedPods?: Record<string, string>;
}

/** The budget's rule as one phrase: "at least 2 available" / "at most 25% unavailable". */
export function pdbRule(spec: PdbSpec): string | undefined {
  if (spec.minAvailable !== undefined) return `at least ${spec.minAvailable} available`;
  if (spec.maxUnavailable !== undefined) return `at most ${spec.maxUnavailable} unavailable`;
  return undefined;
}

/**
 * Whether a drain would stall on this budget right now, and why: no
 * disruptions allowed while pods are expected means every eviction gets a
 * 429 until something becomes healthy.
 */
export function pdbBlocksEvictions(status: PdbStatus | undefined): boolean {
  return (status?.expectedPods ?? 0) > 0 && (status?.disruptionsAllowed ?? 0) === 0;
}

/**
 * A PodDisruptionBudget in the terms a drain cares about: how many pods may
 * go right now, against how many are healthy and how many the budget wants,
 * with the pods it covers listed underneath.
 */
export function PodDisruptionBudgetDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const spec = (obj.spec ?? {}) as PdbSpec;
  const status = obj.status as PdbStatus | undefined;
  const namespace = obj.metadata.namespace;
  const selectorText = labelSelectorToString(spec.selector);
  const podsQuery = useResourceList(namespace && selectorText ? { ctx, group: '', version: 'v1', plural: 'pods', namespace, labelSelector: selectorText } : undefined, {
    liveMs: DETAIL_LIST_LIVE_MS,
  });
  const pods = podsQuery.data?.items ?? [];
  const blocked = pdbBlocksEvictions(status);
  const allowed = status?.disruptionsAllowed;
  const healthy = status?.currentHealthy;
  const desired = status?.desiredHealthy;
  const disrupted = Object.keys(status?.disruptedPods ?? {});
  const stale = obj.metadata.generation !== undefined && status?.observedGeneration !== undefined && status.observedGeneration < obj.metadata.generation;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          {
            label: 'Disruptions allowed',
            value: allowed !== undefined ? String(allowed) : '—',
            tone: allowed === undefined ? undefined : blocked ? 'error' : 'success',
            hint: 'How many of the covered pods may be evicted right now (drains, node upgrades, descheduling).',
          },
          {
            label: 'Healthy',
            value: healthy !== undefined && desired !== undefined ? `${healthy} / ${desired}` : (healthy ?? '—'),
            tone: healthy !== undefined && desired !== undefined ? (healthy < desired ? 'warning' : 'success') : undefined,
            hint: 'Currently healthy pods against the number the budget requires to stay healthy.',
          },
          { label: 'Expected pods', value: status?.expectedPods !== undefined ? String(status.expectedPods) : '—', hint: 'Pods the selector covers, as the controller last counted them.' },
          { label: 'Rule', value: pdbRule(spec) ?? 'none', span: 2 },
        ]}
      />
      {blocked && (
        <ProblemBanner
          severity="warning"
          title="Evictions are blocked by this budget"
          items={[
            {
              title: `${healthy ?? 0} healthy of ${desired ?? 0} required`,
              message:
                'A node drain or cluster upgrade evicting one of these pods will wait on this budget until another pod becomes healthy. Scale the workload up, fix the unhealthy pods, or relax the budget.',
            },
          ]}
        />
      )}
      {stale && (
        <ProblemBanner severity="warning" title="Status is behind the spec" items={[{ title: 'The controller has not reconciled the latest change yet', message: 'The numbers above describe the previous generation of this budget.' }]} />
      )}
      <Section title="Covered pods" count={podsQuery.isLoading ? undefined : pods.length} flush description={selectorText ? <Box component="span" sx={{ fontFamily: 'monospace' }}>{selectorText}</Box> : 'no selector'}>
        <PodMiniList ctx={ctx} pods={pods} loading={podsQuery.isLoading} emptyText={selectorText ? 'No pods match the selector.' : 'This budget has no selector, so it covers nothing.'} hideNamespace />
      </Section>
      <Section title="Details">
        <Facts>
          <Fact label="Min available" hint="Pods that must stay up; an integer or a percentage of the expected pods.">
            {spec.minAvailable !== undefined ? String(spec.minAvailable) : undefined}
          </Fact>
          <Fact label="Max unavailable" hint="Pods that may be down at once; an integer or a percentage.">
            {spec.maxUnavailable !== undefined ? String(spec.maxUnavailable) : undefined}
          </Fact>
          <Fact label="Selector" mono>
            {selectorText}
          </Fact>
          <Fact label="Unhealthy pods" hint="AlwaysAllow lets unhealthy pods be evicted even when the budget is exhausted; IfHealthyBudget (default) only when the budget is met.">
            {spec.unhealthyPodEvictionPolicy}
          </Fact>
          <Fact label="Being disrupted">{disrupted.length ? disrupted.join(', ') : undefined}</Fact>
        </Facts>
      </Section>
      <ConditionsTable obj={obj} defaultOpen={false} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
    </DetailStack>
  );
}
