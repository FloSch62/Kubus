import type { FastifyBaseLogger } from 'fastify';
import type { HelmRollbackResult } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { HttpProblem } from '../util/errors.js';
import { applyDoc, createReleaseRecord, deleteDoc, docKey, docLabel, manifestDocs, patchReleaseRecord, rfc3339Local } from './common.js';
import { execHooks } from './hooks.js';
import { decodeReleaseRecord, listReleaseRecords, revOf, type HelmReleasePayload } from './release-reader.js';

/**
 * Roll a release back to an earlier revision the way the helm CLI does:
 * run the target revision's pre-rollback hooks, re-apply its stored manifest
 * (server-side apply), prune resources only present in the current revision,
 * run post-rollback hooks, mark previously deployed records superseded and
 * write a new release record vN+1.
 */
export async function rollbackRelease(
  handle: ClusterHandle,
  namespace: string,
  name: string,
  toRevision: number,
  log: FastifyBaseLogger,
  skipHooks = false,
): Promise<HelmRollbackResult> {
  const records = await listReleaseRecords(handle, namespace, name);
  if (!records.length) throw new HttpProblem(404, `helm release "${namespace}/${name}" not found`);
  records.sort((a, b) => revOf(b) - revOf(a));
  const latestRecord = records[0]!;
  const latestRev = revOf(latestRecord);
  if (toRevision >= latestRev) throw new HttpProblem(422, `revision ${toRevision} is not older than the current revision ${latestRev}`);
  const targetRecord = records.find((s) => revOf(s) === toRevision);
  if (!targetRecord) throw new HttpProblem(404, `revision ${toRevision} not found`);

  // Deep-copy: decodeReleaseRecord caches payloads and they must not be mutated.
  const target = JSON.parse(JSON.stringify(decodeReleaseRecord(targetRecord))) as HelmReleasePayload;
  const latest = decodeReleaseRecord(latestRecord);

  const result: HelmRollbackResult = { newRevision: latestRev + 1, applied: [], pruned: [], failed: [], hooksRan: [] };

  if (!skipHooks) {
    await execHooks(handle, target.hooks, 'pre-rollback', namespace, log, result.hooksRan);
  }

  // 1. Re-apply the target revision's manifest (create-or-update per doc).
  const targetDocs = manifestDocs(target.manifest, namespace);
  for (const doc of targetDocs) {
    const label = docLabel(doc);
    try {
      await applyDoc(handle, doc);
      result.applied.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm rollback: apply failed');
      result.failed.push({ resource: label, error: message });
    }
  }

  // 2. Prune resources present in the current revision but not in the target.
  const targetKeys = new Set(targetDocs.map(docKey));
  const pruneDocs = manifestDocs(latest.manifest, namespace).filter((d) => !targetKeys.has(docKey(d)));
  for (const doc of pruneDocs.reverse()) {
    const label = docLabel(doc);
    try {
      await deleteDoc(handle, doc);
      result.pruned.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm rollback: prune failed');
      result.failed.push({ resource: label, error: message });
    }
  }

  if (!skipHooks) {
    await execHooks(handle, target.hooks, 'post-rollback', namespace, log, result.hooksRan);
  }

  // 3. Mark previously deployed records superseded.
  for (const record of records) {
    const payload = decodeReleaseRecord(record);
    if (payload.info?.status !== 'deployed') continue;
    const superseded = JSON.parse(JSON.stringify(payload)) as HelmReleasePayload;
    superseded.info = { ...superseded.info, status: 'superseded' };
    try {
      await patchReleaseRecord(handle, namespace, record.metadata.name, superseded, record.driver);
    } catch (err) {
      log.warn({ record: record.metadata.name, err: String(err) }, 'helm rollback: superseded update failed');
    }
  }

  // 4. Write the new release record (a copy of the target at revision N+1).
  const newPayload: HelmReleasePayload = {
    ...target,
    version: latestRev + 1,
    info: {
      ...target.info,
      status: 'deployed',
      last_deployed: rfc3339Local(new Date()),
      description: `Rollback to ${toRevision}`,
    },
  };
  await createReleaseRecord(handle, newPayload, latestRecord.driver);

  return result;
}
