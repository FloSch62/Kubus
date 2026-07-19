import type { FastifyBaseLogger } from 'fastify';
import type { HelmOperationFailure, HelmOperationPhase, HelmRollbackResult } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { HttpProblem } from '../util/errors.js';
import { dumpYaml } from '../util/yaml.js';
import { applyDoc, createReleaseRecord, deleteDoc, docKey, docLabel, manifestDocs, patchReleaseRecord, rfc3339Local } from './common.js';
import { execHooks } from './hooks.js';
import { HelmReadinessError, waitForResources } from './readiness.js';
import { decodeReleaseRecord, listReleaseRecords, revOf, type HelmReleasePayload } from './release-reader.js';
import type { HelmProgressReporter } from './operations.js';

export interface RollbackOptions {
  skipHooks?: boolean;
  wait?: boolean;
  timeoutSeconds?: number;
  report?: HelmProgressReporter;
}

type PodTemplateWorkload = {
  spec?: {
    template?: {
      metadata?: { annotations?: Record<string, string> };
    };
  };
};

/**
 * A rollback can return to an already-existing ReplicaSet whose pods still
 * hold Secret/ConfigMap values from the failed revision. Force a fresh pod
 * template revision so every restored dependency is loaded before readiness.
 */
function forceRollbackRollout(docs: ReturnType<typeof manifestDocs>, revision: number): void {
  for (const doc of docs) {
    if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(doc.kind ?? '')) continue;
    const workload = doc as typeof doc & PodTemplateWorkload;
    workload.spec ??= {};
    workload.spec.template ??= {};
    workload.spec.template.metadata ??= {};
    workload.spec.template.metadata.annotations ??= {};
    workload.spec.template.metadata.annotations['kubus.dev/helm-rollback-revision'] = String(revision);
  }
}

function serializeManifest(docs: ReturnType<typeof manifestDocs>): string {
  return docs.map((doc) => `---\n${dumpYaml(doc, { noRefs: true })}`).join('');
}

/**
 * Roll a release back using Helm-compatible records and lifecycle ordering:
 * run the target revision's pre-rollback hooks, reconcile its stored manifest
 * with server-side apply, prune resources only present in the current
 * revision, run post-rollback hooks, mark previously deployed records
 * superseded and write a new release record vN+1.
 */
export async function rollbackRelease(
  handle: ClusterHandle,
  namespace: string,
  name: string,
  toRevision: number,
  log: FastifyBaseLogger,
  opts: RollbackOptions = {},
): Promise<HelmRollbackResult> {
  opts.report?.({ phase: 'rendering', message: `Loading release history and revision ${toRevision}` });
  const records = await listReleaseRecords(handle, namespace, name);
  if (!records.length) throw new HttpProblem(404, `helm release "${namespace}/${name}" not found`);
  records.sort((a, b) => revOf(b) - revOf(a));
  const latestRecord = records[0]!;
  const latestRev = revOf(latestRecord);
  const latest = decodeReleaseRecord(latestRecord);
  if (latest.info?.status?.startsWith('pending')) {
    throw new HttpProblem(409, `release is in state "${latest.info.status}" — another operation may be in progress`);
  }
  if (toRevision >= latestRev) throw new HttpProblem(422, `revision ${toRevision} is not older than the current revision ${latestRev}`);
  const targetRecord = records.find((s) => revOf(s) === toRevision);
  if (!targetRecord) throw new HttpProblem(404, `revision ${toRevision} not found`);

  // Deep-copy: decodeReleaseRecord caches payloads and they must not be mutated.
  const target = JSON.parse(JSON.stringify(decodeReleaseRecord(targetRecord))) as HelmReleasePayload;
  const newRevision = latestRev + 1;
  const targetDocs = manifestDocs(target.manifest, namespace);
  forceRollbackRollout(targetDocs, newRevision);
  // Capture prune identity before applying: applyDoc strips the stamped
  // namespace from cluster-scoped docs in place, and keys computed after that
  // would never match the current revision — pruning ClusterRoles and other
  // cluster-wide resources the release still owns.
  const targetKeys = new Set(targetDocs.map(docKey));
  opts.report?.({
    phase: 'rendering',
    message: `Prepared revision ${toRevision} as new revision ${newRevision}`,
    targetVersion: target.chart?.metadata?.version,
    revision: newRevision,
  });
  const result: HelmRollbackResult = { newRevision, applied: [], pruned: [], failed: [], hooksRan: [] };
  const newPayload: HelmReleasePayload = {
    ...target,
    version: newRevision,
    info: {
      ...target.info,
      status: 'pending-rollback',
      last_deployed: rfc3339Local(new Date()),
      description: `Rollback to ${toRevision} underway`,
    },
  };
  const recordName = await createReleaseRecord(handle, newPayload, latestRecord.driver);
  opts.report?.({
    phase: opts.skipHooks ? 'applying' : 'pre-hook',
    message: `Created pending rollback revision from revision ${toRevision}`,
    revision: newRevision,
    currentResource: undefined,
  });
  const fail = async (description: string, phase: HelmOperationPhase): Promise<never> => {
    newPayload.info = { ...newPayload.info, status: 'failed', description };
    await patchReleaseRecord(handle, namespace, recordName, newPayload, latestRecord.driver).catch(() => {});
    const details: HelmOperationFailure = {
      operation: 'rollback',
      phase,
      revision: newRevision,
      recoveryRevision: toRevision,
      applied: result.applied,
      pruned: result.pruned,
      failed: result.failed,
      hooksRan: result.hooksRan,
      suggestions: [
        'Inspect the failed workload, pod logs, and namespace events.',
        'Do not repeat a rollback when the application database or persisted data is not backward compatible.',
        'Follow the application vendor recovery procedure or restore a data backup.',
      ],
    };
    throw new HttpProblem(500, description, 'HelmRollbackFailed', details);
  };

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, target.hooks, 'pre-rollback', namespace, log, result.hooksRan, (message, resource) =>
        opts.report?.({ phase: 'pre-hook', message, currentResource: resource }),
      );
    } catch (err) {
      return fail(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`, 'pre-hook');
    }
  }

  // 1. Re-apply the target revision's manifest (create-or-update per doc).
  for (let index = 0; index < targetDocs.length; index++) {
    const doc = targetDocs[index]!;
    const label = docLabel(doc);
    opts.report?.({
      phase: 'applying',
      message: `Restoring resources (${index + 1}/${targetDocs.length})`,
      currentResource: label,
      completedResources: index,
      totalResources: targetDocs.length,
      waitingFor: undefined,
    });
    try {
      await applyDoc(handle, doc);
      result.applied.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm rollback: apply failed');
      result.failed.push({ resource: label, error: message });
      return fail(`Rollback failed: could not apply ${label}: ${message}`, 'apply');
    }
  }
  opts.report?.({
    phase: 'applying',
    message: `Restored ${targetDocs.length} resources`,
    completedResources: targetDocs.length,
    totalResources: targetDocs.length,
    currentResource: undefined,
  });
  // Persist the rollout annotation as part of the new revision's manifest so
  // history/diffs match the live resources.
  newPayload.manifest = serializeManifest(targetDocs);
  await patchReleaseRecord(handle, namespace, recordName, newPayload, latestRecord.driver).catch((err: unknown) =>
    log.warn({ record: recordName, err: String(err) }, 'helm rollback: pending manifest update failed'),
  );

  // 2. Prune resources present in the current revision but not in the target.
  let reversedPruneDocs: ReturnType<typeof manifestDocs>;
  try {
    reversedPruneDocs = manifestDocs(latest.manifest, namespace)
      .filter((d) => !targetKeys.has(docKey(d)))
      .reverse();
  } catch (err) {
    return fail(`Rollback failed: current revision's manifest is not parseable YAML: ${err instanceof Error ? err.message : String(err)}`, 'prune');
  }
  for (let index = 0; index < reversedPruneDocs.length; index++) {
    const doc = reversedPruneDocs[index]!;
    const label = docLabel(doc);
    opts.report?.({
      phase: 'pruning',
      message: `Removing newer resources (${index + 1}/${reversedPruneDocs.length})`,
      currentResource: label,
      completedResources: index,
      totalResources: reversedPruneDocs.length,
      waitingFor: undefined,
    });
    try {
      await deleteDoc(handle, doc);
      result.pruned.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm rollback: prune failed');
      result.failed.push({ resource: label, error: message });
      return fail(`Rollback failed: could not remove ${label}: ${message}`, 'prune');
    }
  }
  if (reversedPruneDocs.length) {
    opts.report?.({
      phase: 'pruning',
      message: `Removed ${reversedPruneDocs.length} newer resources`,
      completedResources: reversedPruneDocs.length,
      totalResources: reversedPruneDocs.length,
      currentResource: undefined,
    });
  }

  if (opts.wait ?? true) {
    try {
      await waitForResources(
        handle,
        targetDocs,
        opts.timeoutSeconds ?? 300,
        (progress) =>
          opts.report?.({
            phase: 'readiness',
            message: progress.recovering.length
              ? `Resolving ${progress.recovering.length} ReadWriteOnce volume rollout deadlock${progress.recovering.length === 1 ? '' : 's'} with brief downtime`
              : progress.pending.length
                ? `Waiting for ${progress.pending.length} of ${progress.total} workloads`
                : `All ${progress.total} workloads are ready`,
            completedResources: progress.ready,
            totalResources: progress.total,
            currentResource: progress.pending[0]?.resource,
            waitingFor: progress.pending,
          }),
        { recoverMultiAttach: true },
      );
    } catch (err) {
      if (err instanceof HelmReadinessError) {
        result.failed.push(...err.issues.map((issue) => ({ resource: issue.resource, error: issue.message })));
      }
      return fail(`Rollback failed while waiting for workloads: ${err instanceof Error ? err.message : String(err)}`, 'readiness');
    }
  }

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, target.hooks, 'post-rollback', namespace, log, result.hooksRan, (message, resource) =>
        opts.report?.({ phase: 'post-hook', message, currentResource: resource, waitingFor: undefined }),
      );
    } catch (err) {
      return fail(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`, 'post-hook');
    }
  }

  // 3. Finalize the new revision first, keeping the old deployed record as a
  // recovery anchor if storage finalization itself fails.
  newPayload.info = {
    ...newPayload.info,
    status: 'deployed',
    last_deployed: rfc3339Local(new Date()),
    description: `Rollback to ${toRevision}`,
  };
  opts.report?.({
    phase: 'recording',
    message: 'Finalizing Helm release history',
    currentResource: undefined,
    completedResources: undefined,
    totalResources: undefined,
    waitingFor: undefined,
  });
  try {
    await patchReleaseRecord(handle, namespace, recordName, newPayload, latestRecord.driver);
  } catch (err) {
    return fail(`Rollback applied, but the release record could not be finalized: ${err instanceof Error ? err.message : String(err)}`, 'record');
  }

  // 4. Mark previously deployed records superseded.
  for (const record of records) {
    let payload: HelmReleasePayload;
    try {
      payload = decodeReleaseRecord(record);
    } catch (err) {
      // The rollback already succeeded; an undecodable old record must not fail it.
      log.warn({ record: record.metadata.name, err: String(err) }, 'helm rollback: skipping undecodable record');
      continue;
    }
    if (payload.info?.status !== 'deployed') continue;
    const superseded = JSON.parse(JSON.stringify(payload)) as HelmReleasePayload;
    superseded.info = { ...superseded.info, status: 'superseded' };
    try {
      await patchReleaseRecord(handle, namespace, record.metadata.name, superseded, record.driver);
    } catch (err) {
      log.warn({ record: record.metadata.name, err: String(err) }, 'helm rollback: superseded update failed');
    }
  }

  return result;
}
