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
// Every Flux object (Kustomization, HelmRelease, the sources) honours both
// the reconcile annotation and spec.suspend.
const isFluxObject = (group: string) => group.endsWith('.toolkit.fluxcd.io');

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
  spec?: { source?: { targetRevision?: string }; sources?: Array<{ targetRevision?: string }> };
  status?: { operationState?: { phase?: string } };
}

/**
 * Start a sync the way `argocd app sync` does: an `operation.sync` for the
 * revision(s) the Application tracks. Refused while another operation is
 * pending or running, since the controller would drop one of the two.
 */
async function argoSync(handle: ClusterHandle, target: Target, prune: boolean): Promise<void> {
  const app = await handle.raw.json<KubeObject & ArgoApplicationShape>(resourcePath(target.group, target.version, target.plural, { namespace: target.namespace, name: target.name }));
  if (app.operation || app.status?.operationState?.phase === 'Running') {
    throw new HttpProblem(409, `${target.name} already has an operation in progress`);
  }
  const sources = app.spec?.sources ?? [];
  const sync: Record<string, unknown> = { prune };
  if (sources.length) sync.revisions = sources.map((source) => source.targetRevision || 'HEAD');
  else sync.revision = app.spec?.source?.targetRevision || 'HEAD';
  await mergePatch(handle, target, { operation: { initiatedBy: { username: 'kubus' }, sync } });
}

interface RolloutShape {
  spec?: { paused?: boolean; strategy?: { canary?: { steps?: unknown[] } } };
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

/**
 * `kubectl argo rollouts promote [--full]`. A plain promote clears the pause
 * conditions (and unpauses spec.paused); when the current step's analysis
 * came back Inconclusive the controller also holds a pause of its own, so the
 * step index moves on past it. A full promote skips every remaining step.
 */
async function promoteRollout(handle: ClusterHandle, target: Target, full: boolean): Promise<void> {
  const ro = await handle.raw.json<KubeObject & RolloutShape>(resourcePath(target.group, target.version, target.plural, { namespace: target.namespace, name: target.name }));
  const status = ro.status ?? {};
  if (full) {
    if (status.currentPodHash && status.currentPodHash === status.stableRS) {
      throw new HttpProblem(409, `${target.name} is already fully promoted`);
    }
    await patchStatus(handle, target, { status: { promoteFull: true } });
  } else {
    const steps = ro.spec?.strategy?.canary?.steps?.length ?? 0;
    const inconclusive = status.canary?.currentStepAnalysisRunStatus?.status === 'Inconclusive';
    if (inconclusive && status.controllerPause && (status.pauseConditions?.length ?? 0) > 0 && status.currentStepIndex !== undefined) {
      await patchStatus(handle, target, { status: { pauseConditions: null, currentStepIndex: Math.min(status.currentStepIndex + 1, steps) } });
    } else {
      await patchStatus(handle, target, { status: { pauseConditions: null } });
    }
  }
  if (ro.spec?.paused) await mergePatch(handle, target, { spec: { paused: false } });
}

export async function runOperatorAction(handle: ClusterHandle, req: OperatorActionRequest): Promise<void> {
  const applies = APPLIES_TO[req.action];
  if (!applies) throw new HttpProblem(422, `unknown action ${String(req.action)}`);
  if (!applies(req.group, req.plural)) throw new HttpProblem(422, `${req.action} does not apply to ${req.plural}.${req.group || 'core'}`);
  if (!req.name || !req.namespace || !req.version) throw new HttpProblem(422, 'namespace, name and version are required');
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
