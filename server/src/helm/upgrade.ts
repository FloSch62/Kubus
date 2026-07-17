import type { FastifyBaseLogger } from 'fastify';
import type { HelmActionResult, HelmDryRunResult } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { HttpProblem } from '../util/errors.js';
import { applyDoc, clusterCapabilities, createReleaseRecord, deleteDoc, docKey, docLabel, manifestDocs, patchReleaseRecord, rfc3339Local } from './common.js';
import { renderChart } from './engine.js';
import { execHooks } from './hooks.js';
import { decodeReleaseRecord, listReleaseRecords, revOf, type HelmReleasePayload } from './release-reader.js';

export interface UpgradeOptions {
  namespace: string;
  name: string;
  /** Complete user-supplied values for the new revision (helm -f semantics). */
  values: Record<string, unknown>;
  /** base64 chart .tgz — omitted to reuse the chart stored in the release. */
  chartArchive?: string;
  skipHooks?: boolean;
  dryRun?: boolean;
}

export async function upgradeRelease(handle: ClusterHandle, opts: UpgradeOptions, log: FastifyBaseLogger): Promise<HelmActionResult | HelmDryRunResult> {
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

  if (opts.dryRun) {
    return {
      manifest: rendered.manifest,
      notes: rendered.notes,
      hooks: rendered.hooks.map((h) => ({ name: h.name, kind: h.kind, events: h.events ?? [] })),
      chart: rendered.metadata.name,
      chartVersion: rendered.metadata.version,
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
  };
  const recordName = await createReleaseRecord(handle, payload, driver);

  const result: HelmActionResult = { revision: newRev, applied: [], pruned: [], failed: [], hooksRan: [], notes: rendered.notes };
  const fail = async (description: string): Promise<never> => {
    payload.info = { ...payload.info, status: 'failed', description };
    await patchReleaseRecord(handle, opts.namespace, recordName, payload, driver).catch(() => {});
    throw new HttpProblem(500, description);
  };

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, rendered.hooks, 'pre-upgrade', opts.namespace, log, result.hooksRan);
    } catch (err) {
      return fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const newDocs = manifestDocs(rendered.manifest, opts.namespace);
  for (const doc of newDocs) {
    const label = docLabel(doc);
    try {
      await applyDoc(handle, doc);
      result.applied.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm upgrade: apply failed');
      result.failed.push({ resource: label, error: message });
      return fail(`Upgrade failed: could not apply ${label}: ${message}`);
    }
  }

  // Prune resources that were in the previous revision but not in this one.
  const newKeys = new Set(newDocs.map(docKey));
  const pruneDocs = manifestDocs(current.manifest, opts.namespace).filter((d) => !newKeys.has(docKey(d)));
  for (const doc of pruneDocs.reverse()) {
    const label = docLabel(doc);
    try {
      await deleteDoc(handle, doc);
      result.pruned.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm upgrade: prune failed');
      result.failed.push({ resource: label, error: message });
    }
  }

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, rendered.hooks, 'post-upgrade', opts.namespace, log, result.hooksRan);
    } catch (err) {
      return fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Mark previously deployed records superseded, then flip the new one live.
  for (const record of records) {
    const prev = decodeReleaseRecord(record);
    if (prev.info?.status !== 'deployed') continue;
    const superseded = JSON.parse(JSON.stringify(prev)) as HelmReleasePayload;
    superseded.info = { ...superseded.info, status: 'superseded' };
    await patchReleaseRecord(handle, opts.namespace, record.metadata.name, superseded, record.driver).catch((err: unknown) =>
      log.warn({ record: record.metadata.name, err: String(err) }, 'helm upgrade: superseded update failed'),
    );
  }
  payload.info = { ...payload.info, status: 'deployed', description: 'Upgrade complete' };
  await patchReleaseRecord(handle, opts.namespace, recordName, payload, driver);
  return result;
}
