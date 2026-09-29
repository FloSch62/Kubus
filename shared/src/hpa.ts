import type { KubeObject } from './api-types.js';

/**
 * An autoscaler's metrics as "current / target" pairs, the way `kubectl get
 * hpa` prints its TARGETS column. Shared by the HPA list column and the
 * "scales" row a workload's Selected by section shows for its autoscaler.
 */

interface MetricTarget {
  type?: string;
  averageUtilization?: number;
  averageValue?: string;
  value?: string;
}

interface MetricValue {
  averageUtilization?: number;
  averageValue?: string;
  value?: string;
}

interface MetricIdentifier {
  name?: string;
}

interface MetricSpec {
  type?: string;
  resource?: { name?: string; target?: MetricTarget };
  containerResource?: { name?: string; container?: string; target?: MetricTarget };
  pods?: { metric?: MetricIdentifier; target?: MetricTarget };
  object?: { metric?: MetricIdentifier; describedObject?: { kind?: string; name?: string }; target?: MetricTarget };
  external?: { metric?: MetricIdentifier; target?: MetricTarget };
}

interface MetricStatus {
  type?: string;
  resource?: { name?: string; current?: MetricValue };
  containerResource?: { name?: string; container?: string; current?: MetricValue };
  pods?: { metric?: MetricIdentifier; current?: MetricValue };
  object?: { metric?: MetricIdentifier; describedObject?: { kind?: string; name?: string }; current?: MetricValue };
  external?: { metric?: MetricIdentifier; current?: MetricValue };
}

export interface HpaMetric {
  /** "cpu", "memory (app)", "requests_per_second". */
  label: string;
  /** Current value in the target's terms; undefined until the controller has read it. */
  current?: string;
  target: string;
}

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const QUANTITY_RE = /^([+-]?[0-9.]+(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/;

function splitQuantity(q: string): { value: number; suffix: string } | undefined {
  const m = QUANTITY_RE.exec(q.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  return Number.isFinite(value) ? { value, suffix: m[2] ?? '' } : undefined;
}

const BINARY_STEPS = ['Ei', 'Pi', 'Ti', 'Gi', 'Mi', 'Ki', ''];
const DECIMAL_STEPS = ['E', 'P', 'T', 'G', 'M', 'k', '', 'm', 'u', 'n'];

/** Units below `suffix` in its family, largest first: Gi → Mi, Ki, ''. */
function smallerUnits(suffix: string): string[] {
  const steps = suffix && BINARY[suffix] !== undefined ? BINARY_STEPS : DECIMAL_STEPS;
  return steps.slice(steps.indexOf(suffix) + 1);
}

/** Whole numbers from 10 up, two significant digits below. */
function roundForDisplay(value: number): number {
  return Math.abs(value) >= 10 ? Math.round(value) : Number(value.toPrecision(2));
}

/**
 * The current quantity expressed in the target's unit, so the two read as
 * one comparison: "14360Ki" against "64Mi" becomes "14Mi", "0.25" against
 * "500m" becomes "250m". A reading that would round away in the target's
 * unit steps down to the first smaller unit where it is at least 1, so 40Mi
 * against 1Gi stays "40Mi" and 4m against 10 stays "4m" instead of "0".
 * Anything unparsable is shown as the API wrote it.
 */
export function inTargetUnit(current: string, target: string): string {
  const c = splitQuantity(current);
  const t = splitQuantity(target);
  if (!c || !t) return current;
  const factor = (s: string) => BINARY[s] ?? DECIMAL[s] ?? 1;
  const base = c.value * factor(c.suffix);
  const converted = base / factor(t.suffix);
  if (converted === 0) return `0${t.suffix}`;
  if (Math.abs(converted) >= 0.1) return `${roundForDisplay(converted)}${t.suffix}`;
  for (const unit of smallerUnits(t.suffix)) {
    const value = base / factor(unit);
    if (Math.abs(value) >= 1) return `${roundForDisplay(value)}${unit}`;
  }
  return current.trim();
}

function targetText(target: MetricTarget | undefined): string {
  if (!target) return '?';
  if (target.type === 'Utilization' || (target.type === undefined && target.averageUtilization !== undefined)) return `${target.averageUtilization ?? '?'}%`;
  if (target.type === 'AverageValue' || (target.type === undefined && target.averageValue !== undefined)) return target.averageValue ?? '?';
  return target.value ?? target.averageValue ?? '?';
}

function currentText(target: MetricTarget | undefined, current: MetricValue | undefined, targetShown: string): string | undefined {
  if (!current) return undefined;
  if (targetShown.endsWith('%')) return current.averageUtilization !== undefined ? `${current.averageUtilization}%` : undefined;
  const raw = target?.type === 'Value' ? (current.value ?? current.averageValue) : (current.averageValue ?? current.value);
  return raw === undefined ? undefined : inTargetUnit(raw, targetShown);
}

/** Identity of a metric entry, the same for its spec and status halves. */
function metricKey(m: MetricSpec | MetricStatus): string {
  switch (m.type) {
    case 'Resource':
      return `Resource/${m.resource?.name}`;
    case 'ContainerResource':
      return `ContainerResource/${m.containerResource?.name}/${m.containerResource?.container}`;
    case 'Pods':
      return `Pods/${m.pods?.metric?.name}`;
    case 'Object':
      return `Object/${m.object?.metric?.name}/${m.object?.describedObject?.kind}/${m.object?.describedObject?.name}`;
    case 'External':
      return `External/${m.external?.metric?.name}`;
    default:
      return `${m.type}`;
  }
}

function specParts(m: MetricSpec): { label: string; target?: MetricTarget } | undefined {
  switch (m.type) {
    case 'Resource':
      return { label: m.resource?.name ?? 'resource', target: m.resource?.target };
    case 'ContainerResource':
      return { label: `${m.containerResource?.name ?? 'resource'} (${m.containerResource?.container ?? '?'})`, target: m.containerResource?.target };
    case 'Pods':
      return { label: m.pods?.metric?.name ?? 'pods metric', target: m.pods?.target };
    case 'Object':
      return { label: m.object?.metric?.name ?? 'object metric', target: m.object?.target };
    case 'External':
      return { label: m.external?.metric?.name ?? 'external metric', target: m.external?.target };
    default:
      return undefined;
  }
}

function statusValue(m: MetricStatus): MetricValue | undefined {
  return m.resource?.current ?? m.containerResource?.current ?? m.pods?.current ?? m.object?.current ?? m.external?.current;
}

/** Every metric the autoscaler scales on, with its current reading where one exists. */
export function hpaMetrics(hpa: KubeObject): HpaMetric[] {
  const spec = hpa.spec as { metrics?: MetricSpec[]; targetCPUUtilizationPercentage?: number } | undefined;
  const status = hpa.status as { currentMetrics?: MetricStatus[] | null; currentCPUUtilizationPercentage?: number } | undefined;
  // autoscaling/v1 objects only know one CPU target.
  if (!spec?.metrics && spec?.targetCPUUtilizationPercentage !== undefined) {
    const current = status?.currentCPUUtilizationPercentage;
    return [{ label: 'cpu', target: `${spec.targetCPUUtilizationPercentage}%`, current: current !== undefined ? `${current}%` : undefined }];
  }
  const currentByKey = new Map((status?.currentMetrics ?? []).map((m) => [metricKey(m), statusValue(m)]));
  const out: HpaMetric[] = [];
  for (const m of spec?.metrics ?? []) {
    const parts = specParts(m);
    if (!parts) continue;
    const target = targetText(parts.target);
    out.push({ label: parts.label, target, current: currentText(parts.target, currentByKey.get(metricKey(m)), target) });
  }
  return out;
}

/** "cpu 42% / 60%" — one metric as a comparison, "?" while no reading exists. */
export function hpaMetricText(metric: HpaMetric): string {
  return `${metric.label} ${metric.current ?? '?'} / ${metric.target}`;
}

/** All metrics, comma-separated; empty for an autoscaler without any. */
export function hpaMetricsSummary(hpa: KubeObject): string {
  return hpaMetrics(hpa).map(hpaMetricText).join(', ');
}
