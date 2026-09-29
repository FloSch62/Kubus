import type { KubeObject } from '@kubus/shared';

/**
 * Argo Rollouts reading: the strategy, where a canary is in its step list,
 * and which of promote / promote full / abort / retry make sense right now
 * (the same conditions the kubectl plugin and the Rollouts dashboard use).
 */

export interface CanaryStep {
  setWeight?: number;
  pause?: { duration?: string | number };
  setCanaryScale?: { replicas?: number; weight?: number; matchTrafficWeight?: boolean };
  analysis?: { templates?: Array<{ templateName?: string; clusterScope?: boolean }> };
  experiment?: { duration?: string; templates?: Array<{ name?: string }> };
  setHeaderRoute?: { name?: string };
  setMirrorRoute?: { name?: string; percentage?: number };
  plugin?: { name?: string };
}

interface Container {
  name: string;
  image?: string;
}

export interface RolloutSpec {
  replicas?: number;
  paused?: boolean;
  selector?: { matchLabels?: Record<string, string> };
  workloadRef?: { apiVersion?: string; kind?: string; name?: string };
  template?: { spec?: { containers?: Container[] } };
  strategy?: {
    canary?: {
      steps?: CanaryStep[];
      canaryService?: string;
      stableService?: string;
      trafficRouting?: Record<string, unknown>;
      maxSurge?: number | string;
      maxUnavailable?: number | string;
    };
    blueGreen?: {
      activeService?: string;
      previewService?: string;
      autoPromotionEnabled?: boolean;
      autoPromotionSeconds?: number;
      scaleDownDelaySeconds?: number;
    };
  };
}

export interface RolloutStatus {
  phase?: string;
  message?: string;
  abort?: boolean;
  abortedAt?: string;
  controllerPause?: boolean;
  pauseConditions?: Array<{ reason?: string; startTime?: string }>;
  currentStepIndex?: number;
  currentPodHash?: string;
  stableRS?: string;
  replicas?: number;
  readyReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  canary?: {
    weights?: { canary?: { weight?: number }; stable?: { weight?: number } };
    currentStepAnalysisRunStatus?: { name?: string; status?: string; message?: string };
  };
}

export const ROLLOUT_HASH_LABEL = 'rollouts-pod-template-hash';

/** A canary step as a short title plus detail: "Set weight" / "20%". */
export function describeStep(step: CanaryStep): { title: string; detail?: string } {
  if (step.setWeight !== undefined) return { title: 'Set weight', detail: `${step.setWeight}%` };
  if (step.pause) {
    const d = step.pause.duration;
    return { title: 'Pause', detail: d === undefined || d === '' ? 'until promoted' : typeof d === 'number' ? `${d}s` : d };
  }
  if (step.setCanaryScale) {
    const s = step.setCanaryScale;
    return { title: 'Scale canary', detail: s.replicas !== undefined ? `${s.replicas} replicas` : s.weight !== undefined ? `${s.weight}% of replicas` : s.matchTrafficWeight ? 'match traffic weight' : undefined };
  }
  if (step.analysis) return { title: 'Analysis', detail: (step.analysis.templates ?? []).map((t) => t.templateName).filter(Boolean).join(', ') || undefined };
  if (step.experiment) {
    const names = (step.experiment.templates ?? []).map((t) => t.name).filter(Boolean).join(', ');
    return { title: 'Experiment', detail: [names, step.experiment.duration && `for ${step.experiment.duration}`].filter(Boolean).join(' ') || undefined };
  }
  if (step.setHeaderRoute) return { title: 'Header route', detail: step.setHeaderRoute.name };
  if (step.setMirrorRoute) return { title: 'Mirror route', detail: [step.setMirrorRoute.name, step.setMirrorRoute.percentage !== undefined && `${step.setMirrorRoute.percentage}%`].filter(Boolean).join(' ') || undefined };
  if (step.plugin) return { title: 'Plugin', detail: step.plugin.name };
  return { title: Object.keys(step)[0] ?? 'Step' };
}

export function rolloutStrategy(spec: RolloutSpec | undefined): 'Canary' | 'BlueGreen' | undefined {
  if (spec?.strategy?.canary) return 'Canary';
  if (spec?.strategy?.blueGreen) return 'BlueGreen';
  return undefined;
}

export interface RolloutState {
  paused: boolean;
  /** A new revision is rolling out: the current pod hash is not the stable one yet. */
  updating: boolean;
  aborted: boolean;
}

export function rolloutState(ro: KubeObject): RolloutState {
  const spec = ro.spec as RolloutSpec | undefined;
  const status = (ro.status ?? {}) as RolloutStatus;
  return {
    paused: !!spec?.paused || (status.pauseConditions?.length ?? 0) > 0 || !!status.controllerPause || status.phase === 'Paused',
    updating: !!status.currentPodHash && !!status.stableRS && status.currentPodHash !== status.stableRS,
    aborted: !!status.abort,
  };
}

/** Which actions apply now: promote a pause or an update in progress, promote fully or abort an update, retry after an abort. */
export function rolloutActions(ro: KubeObject): { promote: boolean; promoteFull: boolean; abort: boolean; retry: boolean } {
  const s = rolloutState(ro);
  return {
    promote: !s.aborted && (s.paused || s.updating),
    promoteFull: !s.aborted && s.updating,
    abort: !s.aborted && s.updating,
    retry: s.aborted,
  };
}

/** Where each canary step stands: finished, the one the rollout is on, or still ahead. */
export function stepState(index: number, ro: KubeObject): 'done' | 'current' | 'pending' {
  const status = (ro.status ?? {}) as RolloutStatus;
  const steps = (ro.spec as RolloutSpec | undefined)?.strategy?.canary?.steps?.length ?? 0;
  const current = status.currentStepIndex ?? (rolloutState(ro).updating ? 0 : steps);
  if (index < current) return 'done';
  if (index === current && rolloutState(ro).updating) return 'current';
  return current >= steps ? 'done' : 'pending';
}

/** The canary's share of traffic: as the traffic router reports it, else the last setWeight reached. */
export function canaryWeight(ro: KubeObject): number | undefined {
  const status = (ro.status ?? {}) as RolloutStatus;
  const reported = status.canary?.weights?.canary?.weight;
  if (reported !== undefined) return reported;
  const steps = (ro.spec as RolloutSpec | undefined)?.strategy?.canary?.steps;
  if (!steps) return undefined;
  if (!rolloutState(ro).updating) return 0;
  const upTo = Math.min(status.currentStepIndex ?? 0, steps.length);
  let weight = 0;
  for (let i = 0; i < upTo; i++) {
    const w = steps[i]?.setWeight;
    if (w !== undefined) weight = w;
  }
  return weight;
}

/** Rollout status word for the drawer header. */
export function rolloutHeaderStatus(ro: KubeObject): string | undefined {
  const status = (ro.status ?? {}) as RolloutStatus;
  if (status.abort) return 'Aborted';
  return status.phase;
}

export interface ImageRow {
  container: string;
  stable?: string;
  canary?: string;
  changed: boolean;
}

/** Container images of the stable and the new revision side by side, containers of either in order. */
export function imageRows(stable: Container[] | undefined, canary: Container[] | undefined): ImageRow[] {
  const names: string[] = [];
  for (const c of [...(stable ?? []), ...(canary ?? [])]) if (!names.includes(c.name)) names.push(c.name);
  return names.map((name) => {
    const s = stable?.find((c) => c.name === name)?.image;
    const n = canary?.find((c) => c.name === name)?.image;
    return { container: name, stable: s, canary: n, changed: s !== n };
  });
}
