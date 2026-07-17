import type { FastifyBaseLogger } from 'fastify';
import type { KubernetesObject } from '@kubernetes/client-node';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { loadAllYaml } from '../util/yaml.js';
import { execHooks } from './hooks.js';
import { chartCrdNames, getLatestPayload, listReleaseRecords } from './release-reader.js';

export interface UninstallResult {
  deleted: string[];
  failed: Array<{ resource: string; error: string }>;
  hooksRan: string[];
  crdsDeleted: string[];
}

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
  const docs = loadAllYaml(payload.manifest ?? '').filter((d): d is Record<string, unknown> => !!d && typeof d === 'object');

  const result: UninstallResult = { deleted: [], failed: [], hooksRan: [], crdsDeleted: [] };

  if (!skipHooks) {
    await execHooks(handle, payload.hooks, 'pre-delete', namespace, log, result.hooksRan);
  }

  for (const doc of docs.reverse()) {
    const obj = doc as unknown as KubernetesObject;
    if (!obj.kind || !obj.metadata?.name) continue;
    obj.metadata.namespace ??= namespace;
    const label = `${obj.kind}/${obj.metadata.namespace ?? ''}/${obj.metadata.name}`;
    try {
      await handle.objects.delete(obj);
      result.deleted.push(label);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 404) {
        result.deleted.push(label);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ label, err: message }, 'helm uninstall: resource delete failed');
        result.failed.push({ resource: label, error: message });
      }
    }
  }

  if (!skipHooks) {
    await execHooks(handle, payload.hooks, 'post-delete', namespace, log, result.hooksRan).catch((err: unknown) => {
      log.warn({ err: String(err) }, 'helm uninstall: post-delete hooks failed');
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

  for (const record of await listReleaseRecords(handle, namespace, name)) {
    try {
      await handle.raw.request(resourcePath('', 'v1', record.driver === 'secret' ? 'secrets' : 'configmaps', { namespace, name: record.metadata.name }), {
        method: 'DELETE',
      });
    } catch {
      // best-effort
    }
  }
  return result;
}
