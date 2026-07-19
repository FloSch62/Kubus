import type { FastifyBaseLogger } from 'fastify';
import type { HelmActionResult, HelmDryRunResult, HelmOperationFailure, HelmOperationPhase } from '@kubus/shared';
import type { KubernetesObject } from '@kubernetes/client-node';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { HttpProblem } from '../util/errors.js';
import { applyDoc, clusterCapabilities, createReleaseRecord, deleteDoc, docKey, docLabel, manifestDocs, patchReleaseRecord, rfc3339Local } from './common.js';
import { renderChart } from './engine.js';
import { execHooks } from './hooks.js';
import { HelmReadinessError, rolloutSafetyWarnings, validateResources, waitForResources } from './readiness.js';
import { decodeReleaseRecord, listReleaseRecords, revOf, type HelmReleasePayload } from './release-reader.js';
import type { HelmProgressReporter } from './operations.js';

export interface UpgradeOptions {
  namespace: string;
  name: string;
  /** Complete user-supplied values for the new revision (helm -f semantics). */
  values: Record<string, unknown>;
  /** base64 chart .tgz — omitted to reuse the chart stored in the release. */
  chartArchive?: string;
  skipHooks?: boolean;
  wait?: boolean;
  timeoutSeconds?: number;
  dryRun?: boolean;
  report?: HelmProgressReporter;
}

export async function upgradeRelease(handle: ClusterHandle, opts: UpgradeOptions, log: FastifyBaseLogger): Promise<HelmActionResult | HelmDryRunResult> {
  opts.report?.({ phase: 'rendering', message: 'Loading the current release and rendering the target chart' });
  const records = await listReleaseRecords(handle, opts.namespace, opts.name);
  if (!records.length) throw new HttpProblem(404, `helm release "${opts.namespace}/${opts.name}" not found`);
  records.sort((a, b) => revOf(b) - revOf(a));
  const latestRecord = records[0]!;
  const driver = latestRecord.driver;
  const latestRev = revOf(latestRecord);
  const current = decodeReleaseRecord(latestRecord);
  if (current.info?.status?.startsWith('pending')) {
    throw new HttpProblem(409, `release is in state "${current.info.status}" — another operation may be in progress`);
  }

  // Values-only upgrades re-render the chart stored in the release record.
  // That record does not preserve subchart dependencies, so charts that
  // declare any need a fresh archive from a repository.
  let chartSource: { chartArchive: string } | { chartJSON: unknown };
  if (opts.chartArchive) {
    chartSource = { chartArchive: opts.chartArchive };
  } else {
    const deps = current.chart?.metadata?.dependencies ?? [];
    if (deps.length) {
      throw new HttpProblem(
        422,
        `chart "${current.chart?.metadata?.name}" declares ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'}, which the in-cluster release record does not preserve — pick a chart version from a repository instead`,
      );
    }
    chartSource = { chartJSON: current.chart };
  }

  const newRev = latestRev + 1;
  const caps = await clusterCapabilities(handle);
  const rendered = await renderChart({
    ...chartSource,
    values: opts.values,
    release: { name: opts.name, namespace: opts.namespace, revision: newRev, isUpgrade: true },
    kubeVersion: caps.kubeVersion,
    apiVersions: caps.apiVersions,
  });
  opts.report?.({
    phase: 'rendering',
    message: `Rendered ${rendered.metadata.name}-${rendered.metadata.version}`,
    targetVersion: rendered.metadata.version,
    revision: newRev,
  });

  if (opts.dryRun) {
    const manifest = manifestDocs(rendered.manifest, opts.namespace);
    const docs = [...manifest, ...rendered.hooks.flatMap((hook) => manifestDocs(hook.manifest, opts.namespace))];
    return {
      manifest: rendered.manifest,
      notes: rendered.notes,
      hooks: rendered.hooks.map((h) => ({ name: h.name, kind: h.kind, events: h.events ?? [] })),
      chart: rendered.metadata.name,
      chartVersion: rendered.metadata.version,
      computedValues: rendered.computedValues,
      validation: await validateResources(handle, docs),
      warnings: rolloutSafetyWarnings(manifest),
    };
  }

  const now = rfc3339Local(new Date());
  const payload: HelmReleasePayload = {
    name: opts.name,
    namespace: opts.namespace,
    version: newRev,
    info: {
      status: 'pending-upgrade',
      first_deployed: current.info?.first_deployed ?? now,
      last_deployed: now,
      description: 'Preparing upgrade',
      notes: rendered.notes,
    },
    chart: rendered.chartJSON as HelmReleasePayload['chart'],
    config: opts.values,
    manifest: rendered.manifest,
    hooks: rendered.hooks,
    kubus: { computedValues: rendered.computedValues },
  };
  // Resolve the recovery hint before creating the pending record: a throw in
  // here after creation would strand the release in pending-upgrade forever.
  const recoveryRevision = records
    .filter((record) => {
      try {
        return ['deployed', 'superseded'].includes(decodeReleaseRecord(record).info?.status ?? '');
      } catch {
        return false; // undecodable record — not a recovery candidate
      }
    })
    .map(revOf)
    .sort((a, b) => b - a)[0];
  const recordName = await createReleaseRecord(handle, payload, driver);
  opts.report?.({
    phase: opts.skipHooks ? 'applying' : 'pre-hook',
    message: 'Created pending upgrade revision',
    revision: newRev,
    currentResource: undefined,
  });

  const result: HelmActionResult = { revision: newRev, applied: [], pruned: [], failed: [], hooksRan: [], notes: rendered.notes };
  const fail = async (description: string, phase: HelmOperationPhase): Promise<never> => {
    payload.info = { ...payload.info, status: 'failed', description };
    await patchReleaseRecord(handle, opts.namespace, recordName, payload, driver).catch(() => {});
    const details: HelmOperationFailure = {
      operation: 'upgrade',
      phase,
      revision: newRev,
      recoveryRevision,
      applied: result.applied,
      pruned: result.pruned,
      failed: result.failed,
      hooksRan: result.hooksRan,
      suggestions: [
        'Inspect the failed workload, pod logs, and namespace events before retrying.',
        'Compare the failed revision with the last successful revision.',
        'Roll back only when the chart and application documentation say data and schema downgrades are supported.',
      ],
    };
    throw new HttpProblem(500, description, 'HelmUpgradeFailed', details);
  };

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, rendered.hooks, 'pre-upgrade', opts.namespace, log, result.hooksRan, (message, resource) =>
        opts.report?.({ phase: 'pre-hook', message, currentResource: resource }),
      );
    } catch (err) {
      return fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`, 'pre-hook');
    }
  }

  let newDocs: KubernetesObject[];
  try {
    newDocs = manifestDocs(rendered.manifest, opts.namespace);
  } catch (err) {
    return fail(`Upgrade failed: rendered manifest is not parseable YAML: ${err instanceof Error ? err.message : String(err)}`, 'apply');
  }
  // Capture prune identity before applying: applyDoc strips the stamped
  // namespace from cluster-scoped docs in place, and keys computed after that
  // would never match the previous revision — pruning ClusterRoles and other
  // cluster-wide resources the release still owns.
  const newKeys = new Set(newDocs.map(docKey));
  for (let index = 0; index < newDocs.length; index++) {
    const doc = newDocs[index]!;
    const label = docLabel(doc);
    opts.report?.({
      phase: 'applying',
      message: `Applying resources (${index + 1}/${newDocs.length})`,
      currentResource: label,
      completedResources: index,
      totalResources: newDocs.length,
      waitingFor: undefined,
    });
    try {
      await applyDoc(handle, doc);
      result.applied.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm upgrade: apply failed');
      result.failed.push({ resource: label, error: message });
      return fail(`Upgrade failed: could not apply ${label}: ${message}`, 'apply');
    }
  }
  opts.report?.({
    phase: 'applying',
    message: `Applied ${newDocs.length} resources`,
    completedResources: newDocs.length,
    totalResources: newDocs.length,
    currentResource: undefined,
  });

  // Prune resources that were in the previous revision but not in this one.
  let reversedPruneDocs: KubernetesObject[];
  try {
    reversedPruneDocs = manifestDocs(current.manifest, opts.namespace)
      .filter((d) => !newKeys.has(docKey(d)))
      .reverse();
  } catch (err) {
    return fail(`Upgrade failed: previous revision's manifest is not parseable YAML: ${err instanceof Error ? err.message : String(err)}`, 'prune');
  }
  for (let index = 0; index < reversedPruneDocs.length; index++) {
    const doc = reversedPruneDocs[index]!;
    const label = docLabel(doc);
    opts.report?.({
      phase: 'pruning',
      message: `Removing obsolete resources (${index + 1}/${reversedPruneDocs.length})`,
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
      log.warn({ label, err: message }, 'helm upgrade: prune failed');
      result.failed.push({ resource: label, error: message });
      return fail(`Upgrade failed: could not remove obsolete ${label}: ${message}`, 'prune');
    }
  }
  if (reversedPruneDocs.length) {
    opts.report?.({
      phase: 'pruning',
      message: `Removed ${reversedPruneDocs.length} obsolete resources`,
      completedResources: reversedPruneDocs.length,
      totalResources: reversedPruneDocs.length,
      currentResource: undefined,
    });
  }

  if (opts.wait ?? true) {
    try {
      await waitForResources(
        handle,
        newDocs,
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
      return fail(`Upgrade failed while waiting for workloads: ${err instanceof Error ? err.message : String(err)}`, 'readiness');
    }
  }

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, rendered.hooks, 'post-upgrade', opts.namespace, log, result.hooksRan, (message, resource) =>
        opts.report?.({ phase: 'post-hook', message, currentResource: resource, waitingFor: undefined }),
      );
    } catch (err) {
      return fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`, 'post-hook');
    }
  }

  // Flip the new revision live before superseding old records so a storage
  // patch failure never leaves the release with no deployed revision.
  payload.info = { ...payload.info, status: 'deployed', description: 'Upgrade complete' };
  opts.report?.({
    phase: 'recording',
    message: 'Finalizing Helm release history',
    currentResource: undefined,
    completedResources: undefined,
    totalResources: undefined,
    waitingFor: undefined,
  });
  try {
    await patchReleaseRecord(handle, opts.namespace, recordName, payload, driver);
  } catch (err) {
    return fail(`Upgrade applied, but the release record could not be finalized: ${err instanceof Error ? err.message : String(err)}`, 'record');
  }

  // Mark previously deployed records superseded.
  for (const record of records) {
    let prev: HelmReleasePayload;
    try {
      prev = decodeReleaseRecord(record);
    } catch (err) {
      // The upgrade already succeeded; an undecodable old record must not fail it.
      log.warn({ record: record.metadata.name, err: String(err) }, 'helm upgrade: skipping undecodable record');
      continue;
    }
    if (prev.info?.status !== 'deployed') continue;
    const superseded = JSON.parse(JSON.stringify(prev)) as HelmReleasePayload;
    superseded.info = { ...superseded.info, status: 'superseded' };
    await patchReleaseRecord(handle, opts.namespace, record.metadata.name, superseded, record.driver).catch((err: unknown) =>
      log.warn({ record: record.metadata.name, err: String(err) }, 'helm upgrade: superseded update failed'),
    );
  }
  return result;
}
