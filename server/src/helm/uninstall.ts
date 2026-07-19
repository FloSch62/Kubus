import type { FastifyBaseLogger } from 'fastify';
import type { HelmUninstallResult } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { deleteDoc, docLabel, manifestDocs } from './common.js';
import { execHooks } from './hooks.js';
import { chartCrdNames, getLatestPayload, listReleaseRecords, revOf } from './release-reader.js';

export type UninstallResult = HelmUninstallResult;

export interface UninstallOptions {
  skipHooks?: boolean;
  /**
   * Also delete the CRDs shipped in the chart's crds/ directory. Off by
   * default, like helm: dropping a CRD cascade-deletes every custom resource
   * of that kind cluster-wide.
   */
  deleteCrds?: boolean;
}

/**
 * Uninstall a Helm release without the helm binary: run the release's stored
 * pre-delete hooks, delete every resource in the stored manifest (reverse
 * order, best-effort), run post-delete hooks, then remove the release secrets.
 */
export async function uninstallRelease(handle: ClusterHandle, namespace: string, name: string, log: FastifyBaseLogger, opts: UninstallOptions = {}): Promise<UninstallResult> {
  const { skipHooks = false, deleteCrds = false } = opts;
  const payload = await getLatestPayload(handle, namespace, name);
  const docs = manifestDocs(payload.manifest, namespace);

  const result: UninstallResult = { deleted: [], failed: [], hooksRan: [], crdsDeleted: [], recordsRetained: false };

  if (!skipHooks) {
    await execHooks(handle, payload.hooks, 'pre-delete', namespace, log, result.hooksRan);
  }

  for (const doc of docs.reverse()) {
    let label = docLabel(doc);
    try {
      await deleteDoc(handle, doc);
      // Scope resolution may remove an erroneous default namespace from
      // cluster-scoped resources, so report the canonical label afterward.
      label = docLabel(doc);
      result.deleted.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, err: message }, 'helm uninstall: resource delete failed');
      result.failed.push({ resource: label, error: message });
    }
  }

  if (!skipHooks) {
    await execHooks(handle, payload.hooks, 'post-delete', namespace, log, result.hooksRan).catch((err: unknown) => {
      log.warn({ err: String(err) }, 'helm uninstall: post-delete hooks failed');
      result.failed.push({ resource: 'Hook/post-delete', error: err instanceof Error ? err.message : String(err) });
    });
  }

  if (deleteCrds) {
    for (const crdName of chartCrdNames(payload)) {
      const label = `CustomResourceDefinition/${crdName}`;
      try {
        const res = await handle.raw.request(resourcePath('apiextensions.k8s.io', 'v1', 'customresourcedefinitions', { name: crdName }), { method: 'DELETE' });
        if (res.ok || res.status === 404) {
          result.crdsDeleted.push(crdName);
        } else {
          result.failed.push({ resource: label, error: `${res.status} ${await res.text().catch(() => '')}`.trim() });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ crd: crdName, err: message }, 'helm uninstall: crd delete failed');
        result.failed.push({ resource: label, error: message });
      }
    }
    if (result.crdsDeleted.length) handle.discovery.invalidate();
  }

  // Preserve release history when cleanup was incomplete so users can inspect
  // the manifest and retry. When cleanup succeeded, delete oldest-to-newest;
  // keeping the latest record until last avoids making a partial record cleanup
  // disappear from the releases list.
  if (result.failed.length) {
    result.recordsRetained = true;
  } else {
    const records = (await listReleaseRecords(handle, namespace, name)).sort((a, b) => revOf(a) - revOf(b));
    for (const record of records) {
      const label = `${record.driver === 'secret' ? 'Secret' : 'ConfigMap'}/${namespace}/${record.metadata.name}`;
      try {
        const res = await handle.raw.request(
          resourcePath('', 'v1', record.driver === 'secret' ? 'secrets' : 'configmaps', { namespace, name: record.metadata.name }),
          { method: 'DELETE' },
        );
        if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({ resource: label, error: message });
        result.recordsRetained = true;
        break;
      }
    }
  }
  return result;
}
