import type { KubeObject, OperatorAction, OperatorActionRequest } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { HttpProblem } from '../util/errors.js';

/**
 * Operator actions on custom resources. Each one is the patch the operator's
 * own tooling makes (argocd, kubectl-argo-rollouts, the External Secrets
 * docs, flux), so the controllers pick it up exactly as they would from
 * there; Kubus runs no controller logic of its own.
 */

const REFRESH_ANNOTATION = 'argocd.argoproj.io/refresh';
const FORCE_SYNC_ANNOTATION = 'force-sync';
const RECONCILE_ANNOTATION = 'reconcile.fluxcd.io/requestedAt';

const isArgoApplication = (group: string, plural: string) => group === 'argoproj.io' && plural === 'applications';
const isArgoRollout = (group: string, plural: string) => group === 'argoproj.io' && plural === 'rollouts';
const isExternalSecret = (group: string, plural: string) => group === 'external-secrets.io' && plural === 'externalsecrets';

/** The Flux kinds that honour both the reconcile annotation and spec.suspend. */
const FLUX_SUSPENDABLE: Record<string, readonly string[]> = {
  'kustomize.toolkit.fluxcd.io': ['kustomizations'],
  'helm.toolkit.fluxcd.io': ['helmreleases'],
  'source.toolkit.fluxcd.io': ['gitrepositories', 'ocirepositories', 'helmrepositories', 'helmcharts', 'buckets'],
  'notification.toolkit.fluxcd.io': ['alerts', 'providers', 'receivers'],
  'image.toolkit.fluxcd.io': ['imagerepositories', 'imageupdateautomations'],
};
const isFluxObject = (group: string, plural: string) => !!FLUX_SUSPENDABLE[group]?.includes(plural);

const VERSION_RE = /^v\d+(?:(?:alpha|beta)\d+)?$/;
const GROUP_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const PLURAL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const APPLIES_TO: Record<OperatorAction, (group: string, plural: string) => boolean> = {
  'argocd-refresh': isArgoApplication,
  'argocd-sync': isArgoApplication,
  'rollout-promote': isArgoRollout,
  'rollout-promote-full': isArgoRollout,
  'rollout-abort': isArgoRollout,
  'rollout-retry': isArgoRollout,
  'eso-force-sync': isExternalSecret,
  'flux-reconcile': isFluxObject,
  'flux-suspend': isFluxObject,
  'flux-resume': isFluxObject,
};

interface Target {
  group: string;
  version: string;
  plural: string;
  namespace: string;
  name: string;
}

async function mergePatch(handle: ClusterHandle, target: Target, body: unknown, subresource?: string): Promise<void> {
  await handle.raw.json(resourcePath(target.group, target.version, target.plural, { namespace: target.namespace, name: target.name, subresource }), {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify(body),
  });
}

async function annotate(handle: ClusterHandle, target: Target, annotations: Record<string, string>): Promise<void> {
  await mergePatch(handle, target, { metadata: { annotations } });
}

/**
 * Status patches go to the status subresource; a Rollout CRD installed
 * without one takes them on the object itself, as the kubectl plugin does.
 */
async function patchStatus(handle: ClusterHandle, target: Target, body: { status: Record<string, unknown> }): Promise<void> {
  try {
    await mergePatch(handle, target, body, 'status');
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
    await mergePatch(handle, target, body);
  }
}

interface ArgoApplicationShape {
  operation?: unknown;
  spec?: {
    source?: { targetRevision?: string };
    sources?: Array<{ targetRevision?: string }>;
    syncPolicy?: { syncOptions?: string[]; retry?: unknown };
  };
  status?: { operationState?: { phase?: string } };
}

/**
 * Start a sync the way the Argo CD API server does for `argocd app sync`:
 * an `operation.sync` for the revision(s) the Application tracks, carrying
 * the Application's sync options (the controller reads ServerSideApply,
 * Replace, PruneLast and friends from the operation, not the spec) and its
 * retry policy. Refused while another operation is pending or running; the
 * patch is conditional on the resourceVersion that was checked, so an
 * auto-sync that starts in between makes it fail with 409 instead of being
 * overwritten.
 */
async function argoSync(handle: ClusterHandle, target: Target, prune: boolean): Promise<void> {
  const app = await handle.raw.json<KubeObject & ArgoApplicationShape>(resourcePath(target.group, target.version, target.plural, { namespace: target.namespace, name: target.name }));
  if (app.operation || app.status?.operationState?.phase === 'Running') {
    throw new HttpProblem(409, `${target.name} already has an operation in progress`);
  }
  const spec = app.spec ?? {};
  const sources = spec.sources ?? [];
  const sync: Record<string, unknown> = { prune };
  if (sources.length) sync.revisions = sources.map((source) => source.targetRevision || 'HEAD');
  else sync.revision = spec.source?.targetRevision || 'HEAD';
  if (spec.syncPolicy?.syncOptions?.length) sync.syncOptions = spec.syncPolicy.syncOptions;
  const operation: Record<string, unknown> = { initiatedBy: { username: 'kubus' }, sync };
  if (spec.syncPolicy?.retry) operation.retry = spec.syncPolicy.retry;
  await mergePatch(handle, target, { metadata: { resourceVersion: app.metadata.resourceVersion }, operation });
}

interface RolloutShape {
  spec?: { paused?: boolean; strategy?: { canary?: { steps?: unknown[] }; blueGreen?: unknown } };
  status?: {
    abort?: boolean;
    controllerPause?: boolean;
    currentPodHash?: string;
    currentStepIndex?: number;
    pauseConditions?: unknown[];
    stableRS?: string;
    canary?: { currentStepAnalysisRunStatus?: { status?: string } };
  };
}

/** `GetCurrentCanaryStep`: the step index, 0 when unset, undefined without canary steps. */
function currentCanaryStep(ro: RolloutShape): number | undefined {
  if (!ro.spec?.strategy?.canary?.steps?.length) return undefined;
  return ro.status?.currentStepIndex ?? 0;
}

/**
 * The patches `kubectl argo rollouts promote [--full]` makes, branch for
 * branch (getPatches in the plugin): a spec patch, a status patch, and the
 * unified patch used when the CRD has no status subresource.
 */
export function promotePatches(ro: RolloutShape, full: boolean): { spec?: unknown; status?: { status: Record<string, unknown> }; unified: unknown } {
  const spec = ro.spec ?? {};
  const status = ro.status ?? {};
  const steps = spec.strategy?.canary?.steps?.length ?? 0;
  const unpause = spec.paused ? { spec: { paused: false } } : undefined;
  if (full) {
    return {
      spec: unpause,
      status: status.currentPodHash !== status.stableRS ? { status: { promoteFull: true } } : undefined,
      unified: { spec: { paused: false }, status: { promoteFull: true } },
    };
  }
  const index = currentCanaryStep(ro);
  const next = index === undefined ? undefined : index < steps ? index + 1 : index;
  const inconclusive = !!spec.strategy?.canary && status.canary?.currentStepAnalysisRunStatus?.status === 'Inconclusive';
  if (inconclusive && (status.pauseConditions?.length ?? 0) > 0 && status.controllerPause) {
    // Stuck on an Inconclusive analysis: clear the controller's own pause and move past the step.
    return {
      spec: unpause,
      status: next === undefined ? undefined : { status: { pauseConditions: null, controllerPause: false, currentStepIndex: next } },
      unified: { spec: { paused: false }, status: { pauseConditions: null } },
    };
  }
  if ((status.pauseConditions?.length ?? 0) > 0) {
    return { spec: unpause, status: { status: { pauseConditions: null } }, unified: { spec: { paused: false }, status: { pauseConditions: null } } };
  }
  if (spec.strategy?.canary && next !== undefined) {
    // Nothing paused: the canary is mid-step (analysis, experiment), so promote moves on to the next one.
    return {
      spec: unpause,
      status: { status: { pauseConditions: null, currentStepIndex: next } },
      unified: { spec: { paused: false }, status: { pauseConditions: null, currentStepIndex: next } },
    };
  }
  return { spec: unpause, unified: { spec: { paused: false }, status: { pauseConditions: null } } };
}

/**
 * Apply the promote patches as the plugin does: status first on the status
 * subresource, falling back to the unified patch on the object when the CRD
 * has none, then the spec. A promote with nothing to change is refused so
 * the UI does not report a promotion that did not happen.
 */
async function promoteRollout(handle: ClusterHandle, target: Target, full: boolean): Promise<void> {
  const ro = await handle.raw.json<KubeObject & RolloutShape>(resourcePath(target.group, target.version, target.plural, { namespace: target.namespace, name: target.name }));
  const patches = promotePatches(ro, full);
  if (!patches.status && !patches.spec) {
    throw new HttpProblem(409, full ? `${target.name} is already fully promoted` : `${target.name} has nothing to promote`);
  }
  let specPatch = patches.spec;
  if (patches.status) {
    try {
      await mergePatch(handle, target, patches.status, 'status');
    } catch (err) {
      if ((err as { code?: number }).code !== 404) throw err;
      specPatch = patches.unified;
    }
  }
  if (specPatch) await mergePatch(handle, target, specPatch);
}

export async function runOperatorAction(handle: ClusterHandle, req: OperatorActionRequest): Promise<void> {
  const applies = APPLIES_TO[req.action];
  if (!applies) throw new HttpProblem(422, `unknown action ${String(req.action)}`);
  if (typeof req.group !== 'string' || !GROUP_RE.test(req.group) || typeof req.plural !== 'string' || !PLURAL_RE.test(req.plural)) {
    throw new HttpProblem(422, 'group and plural must be lower-case API names');
  }
  if (typeof req.version !== 'string' || !VERSION_RE.test(req.version)) throw new HttpProblem(422, 'version must look like v1, v2beta1 or v1alpha1');
  if (!applies(req.group, req.plural)) throw new HttpProblem(422, `${req.action} does not apply to ${req.plural}.${req.group}`);
  if (!req.name || !req.namespace) throw new HttpProblem(422, 'namespace and name are required');
  const target: Target = { group: req.group, version: req.version, plural: req.plural, namespace: req.namespace, name: req.name };
  switch (req.action) {
    case 'argocd-refresh':
      return annotate(handle, target, { [REFRESH_ANNOTATION]: 'normal' });
    case 'argocd-sync':
      return argoSync(handle, target, !!req.prune);
    case 'rollout-promote':
      return promoteRollout(handle, target, false);
    case 'rollout-promote-full':
      return promoteRollout(handle, target, true);
    case 'rollout-abort':
      return patchStatus(handle, target, { status: { abort: true } });
    case 'rollout-retry':
      return patchStatus(handle, target, { status: { abort: false } });
    case 'eso-force-sync':
      return annotate(handle, target, { [FORCE_SYNC_ANNOTATION]: String(Math.floor(Date.now() / 1000)) });
    case 'flux-reconcile':
      return annotate(handle, target, { [RECONCILE_ANNOTATION]: new Date().toISOString() });
    case 'flux-suspend':
      return mergePatch(handle, target, { spec: { suspend: true } });
    case 'flux-resume':
      // Resuming also requests a reconcile, so the object catches up now
      // rather than at its next interval.
      return mergePatch(handle, target, { metadata: { annotations: { [RECONCILE_ANNOTATION]: new Date().toISOString() } }, spec: { suspend: false } });
  }
}
