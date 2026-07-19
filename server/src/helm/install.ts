import type { FastifyBaseLogger } from 'fastify';
import type { HelmActionResult, HelmDryRunResult, HelmOperationFailure, HelmOperationPhase } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem } from '../util/errors.js';
import { loadAllYaml } from '../util/yaml.js';
import type { KubernetesObject } from '@kubernetes/client-node';
import { applyDoc, clusterCapabilities, createDocIfAbsent, createReleaseRecord, docLabel, manifestDocs, patchReleaseRecord, rfc3339Local } from './common.js';
import { renderChart } from './engine.js';
import { execHooks } from './hooks.js';
import { HelmReadinessError, validateResources, waitForResources } from './readiness.js';
import { decodeReleaseRecord, listReleaseRecords, revOf, type HelmReleasePayload } from './release-reader.js';
import type { HelmProgressReporter } from './operations.js';

export interface InstallOptions {
  namespace: string;
  name: string;
  values: Record<string, unknown>;
  /** base64 chart .tgz (already resolved from a repo / OCI ref / URL). */
  chartArchive: string;
  createNamespace?: boolean;
  skipHooks?: boolean;
  wait?: boolean;
  timeoutSeconds?: number;
  dryRun?: boolean;
  report?: HelmProgressReporter;
}

const RELEASE_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export async function installRelease(handle: ClusterHandle, opts: InstallOptions, log: FastifyBaseLogger): Promise<HelmActionResult | HelmDryRunResult> {
  opts.report?.({ phase: 'rendering', message: 'Checking the release name and rendering the chart' });
  if (!RELEASE_NAME_RE.test(opts.name) || opts.name.length > 53) {
    throw new HttpProblem(422, 'release name must be lowercase alphanumeric/dashes, at most 53 characters');
  }

  const existing = await listReleaseRecords(handle, opts.namespace, opts.name);
  if (existing.length && !opts.dryRun) {
    // List order is lexicographic (".v10" before ".v2"); report the real latest revision.
    const latest = existing.reduce((a, b) => (revOf(b) > revOf(a) ? b : a));
    let status = 'unknown';
    try {
      status = decodeReleaseRecord(latest).info?.status ?? 'unknown';
    } catch {
      // undecodable record — the release still exists, report it as unknown
    }
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
  opts.report?.({
    phase: 'rendering',
    message: `Rendered ${rendered.metadata.name}-${rendered.metadata.version}`,
    targetVersion: rendered.metadata.version,
    revision: 1,
  });

  if (opts.dryRun) {
    const docs = [
      ...rendered.crds.flatMap((crd) => manifestDocs(crd.content, opts.namespace)),
      ...manifestDocs(rendered.manifest, opts.namespace),
      ...rendered.hooks.flatMap((hook) => manifestDocs(hook.manifest, opts.namespace)),
    ];
    const validationNamespace = opts.createNamespace ? { from: opts.namespace, to: 'default' } : undefined;
    return {
      manifest: rendered.manifest,
      notes: rendered.notes,
      hooks: rendered.hooks.map((h) => ({ name: h.name, kind: h.kind, events: h.events ?? [] })),
      chart: rendered.metadata.name,
      chartVersion: rendered.metadata.version,
      computedValues: rendered.computedValues,
      validation: await validateResources(handle, docs, validationNamespace),
      warnings: validationNamespace
        ? [`The target namespace does not exist yet; namespaced resources were API-validated in "${validationNamespace.to}" instead.`]
        : [],
    };
  }

  if (opts.createNamespace) {
    opts.report?.({ phase: 'applying', message: `Creating namespace ${opts.namespace}` });
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
      const label = docLabel(obj);
      opts.report?.({ phase: 'applying', message: 'Installing chart CRDs', currentResource: label });
      if (!(await createDocIfAbsent(handle, obj))) {
        log.info({ label }, 'helm install: chart CRD already exists; skipping');
      }
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
    kubus: { computedValues: rendered.computedValues },
  };
  const recordName = await createReleaseRecord(handle, payload);
  opts.report?.({ phase: 'pre-hook', message: 'Created pending install revision', revision: 1, currentResource: undefined });

  const result: HelmActionResult = { revision: 1, applied: [], pruned: [], failed: [], hooksRan: [], notes: rendered.notes };
  const fail = async (description: string, phase: HelmOperationPhase): Promise<never> => {
    payload.info = { ...payload.info, status: 'failed', description };
    await patchReleaseRecord(handle, opts.namespace, recordName, payload).catch(() => {});
    const details: HelmOperationFailure = {
      operation: 'install',
      phase,
      revision: 1,
      applied: result.applied,
      pruned: result.pruned,
      failed: result.failed,
      hooksRan: result.hooksRan,
      suggestions: [
        'Inspect the failed resource, pod logs, and namespace events.',
        'Uninstall the failed release before retrying the install.',
      ],
    };
    throw new HttpProblem(500, description, 'HelmInstallFailed', details);
  };

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, rendered.hooks, 'pre-install', opts.namespace, log, result.hooksRan, (message, resource) =>
        opts.report?.({ phase: 'pre-hook', message, currentResource: resource }),
      );
    } catch (err) {
      return fail(`Install failed: ${err instanceof Error ? err.message : String(err)}`, 'pre-hook');
    }
  }

  let installDocs: KubernetesObject[];
  try {
    installDocs = manifestDocs(rendered.manifest, opts.namespace);
  } catch (err) {
    return fail(`Install failed: rendered manifest is not parseable YAML: ${err instanceof Error ? err.message : String(err)}`, 'apply');
  }
  for (let index = 0; index < installDocs.length; index++) {
    const doc = installDocs[index]!;
    const label = docLabel(doc);
    opts.report?.({
      phase: 'applying',
      message: `Applying resources (${index + 1}/${installDocs.length})`,
      currentResource: label,
      completedResources: index,
      totalResources: installDocs.length,
      waitingFor: undefined,
    });
    try {
      await applyDoc(handle, doc);
      result.applied.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm install: apply failed');
      result.failed.push({ resource: label, error: message });
      return fail(`Install failed: could not apply ${label}: ${message}`, 'apply');
    }
  }
  opts.report?.({
    phase: 'applying',
    message: `Applied ${installDocs.length} resources`,
    completedResources: installDocs.length,
    totalResources: installDocs.length,
    currentResource: undefined,
  });

  if (opts.wait ?? true) {
    try {
      await waitForResources(handle, installDocs, opts.timeoutSeconds ?? 300, (progress) =>
        opts.report?.({
          phase: 'readiness',
          message: progress.pending.length
            ? `Waiting for ${progress.pending.length} of ${progress.total} workloads`
            : `All ${progress.total} workloads are ready`,
          completedResources: progress.ready,
          totalResources: progress.total,
          currentResource: progress.pending[0]?.resource,
          waitingFor: progress.pending,
        }),
      );
    } catch (err) {
      if (err instanceof HelmReadinessError) {
        result.failed.push(...err.issues.map((issue) => ({ resource: issue.resource, error: issue.message })));
      }
      return fail(`Install failed while waiting for workloads: ${err instanceof Error ? err.message : String(err)}`, 'readiness');
    }
  }

  if (!opts.skipHooks) {
    try {
      await execHooks(handle, rendered.hooks, 'post-install', opts.namespace, log, result.hooksRan, (message, resource) =>
        opts.report?.({ phase: 'post-hook', message, currentResource: resource, waitingFor: undefined }),
      );
    } catch (err) {
      return fail(`Install failed: ${err instanceof Error ? err.message : String(err)}`, 'post-hook');
    }
  }

  payload.info = { ...payload.info, status: 'deployed', description: 'Install complete' };
  opts.report?.({
    phase: 'recording',
    message: 'Finalizing Helm release history',
    currentResource: undefined,
    completedResources: undefined,
    totalResources: undefined,
    waitingFor: undefined,
  });
  try {
    await patchReleaseRecord(handle, opts.namespace, recordName, payload);
  } catch (err) {
    return fail(`Install applied, but the release record could not be finalized: ${err instanceof Error ? err.message : String(err)}`, 'record');
  }
  return result;
}
