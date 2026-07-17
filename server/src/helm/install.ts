import type { FastifyBaseLogger } from 'fastify';
import type { HelmActionResult, HelmDryRunResult } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem } from '../util/errors.js';
import { loadAllYaml } from '../util/yaml.js';
import type { KubernetesObject } from '@kubernetes/client-node';
import { applyDoc, clusterCapabilities, createReleaseRecord, docLabel, manifestDocs, patchReleaseRecord, rfc3339Local } from './common.js';
import { renderChart } from './engine.js';
import { execHooks } from './hooks.js';
import { decodeReleaseRecord, listReleaseRecords, type HelmReleasePayload } from './release-reader.js';

export interface InstallOptions {
  namespace: string;
  name: string;
  values: Record<string, unknown>;
  /** base64 chart .tgz (already resolved from a repo / OCI ref / URL). */
  chartArchive: string;
  createNamespace?: boolean;
  skipHooks?: boolean;
  dryRun?: boolean;
}

const RELEASE_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export async function installRelease(handle: ClusterHandle, opts: InstallOptions, log: FastifyBaseLogger): Promise<HelmActionResult | HelmDryRunResult> {
  if (!RELEASE_NAME_RE.test(opts.name) || opts.name.length > 53) {
    throw new HttpProblem(422, 'release name must be lowercase alphanumeric/dashes, at most 53 characters');
  }

  const existing = await listReleaseRecords(handle, opts.namespace, opts.name);
  if (existing.length && !opts.dryRun) {
    const status = decodeReleaseRecord(existing[existing.length - 1]!).info?.status ?? 'unknown';
    throw new HttpProblem(409, `release "${opts.namespace}/${opts.name}" already exists (status: ${status})`);
  }

  const caps = await clusterCapabilities(handle);
  const rendered = await renderChart({
    chartArchive: opts.chartArchive,
    values: opts.values,
    release: { name: opts.name, namespace: opts.namespace, revision: 1, isInstall: true },
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

  if (opts.createNamespace) {
    try {
      await handle.raw.json(resourcePath('', 'v1', 'namespaces'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: opts.namespace } }),
      });
    } catch (err) {
      const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (code !== 409) throw err;
    }
  }

  // CRDs from the chart's crds/ directory go first, like helm install.
  for (const crd of rendered.crds) {
    for (const doc of loadAllYaml(crd.content).filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')) {
      const obj = doc as unknown as KubernetesObject;
      if (!obj.kind || !obj.metadata?.name) continue;
      await applyDoc(handle, obj);
    }
  }
  if (rendered.crds.length) handle.discovery.invalidate();

  const now = rfc3339Local(new Date());
  const payload: HelmReleasePayload = {
    name: opts.name,
    namespace: opts.namespace,
    version: 1,
    info: {
      status: 'pending-install',
      first_deployed: now,
      last_deployed: now,
      description: 'Initial install underway',
      notes: rendered.notes,
    },
    chart: rendered.chartJSON as HelmReleasePayload['chart'],
    config: opts.values,
    manifest: rendered.manifest,
    hooks: rendered.hooks,
  };
  const recordName = await createReleaseRecord(handle, payload);

  const result: HelmActionResult = { revision: 1, applied: [], pruned: [], failed: [], hooksRan: [], notes: rendered.notes };
  const fail = async (description: string): Promise<never> => {
    payload.info = { ...payload.info, status: 'failed', description };
    await patchReleaseRecord(handle, opts.namespace, recordName, payload).catch(() => {});
    throw new HttpProblem(500, description);
  };

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, rendered.hooks, 'pre-install', opts.namespace, log, result.hooksRan);
    } catch (err) {
      return fail(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const doc of manifestDocs(rendered.manifest, opts.namespace)) {
    const label = docLabel(doc);
    try {
      await applyDoc(handle, doc);
      result.applied.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm install: apply failed');
      result.failed.push({ resource: label, error: message });
      return fail(`Install failed: could not apply ${label}: ${message}`);
    }
  }

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, rendered.hooks, 'post-install', opts.namespace, log, result.hooksRan);
    } catch (err) {
      return fail(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  payload.info = { ...payload.info, status: 'deployed', description: 'Install complete' };
  await patchReleaseRecord(handle, opts.namespace, recordName, payload);
  return result;
}
