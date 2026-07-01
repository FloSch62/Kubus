import type { FastifyBaseLogger } from 'fastify';
import type { KubernetesObject } from '@kubernetes/client-node';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { loadAllYaml } from '../util/yaml.js';
import { getLatestPayload, listReleaseSecretObjects } from './release-reader.js';

export interface UninstallResult {
  deleted: string[];
  failed: Array<{ resource: string; error: string }>;
}

/**
 * Uninstall a Helm release without the helm binary: delete every resource
 * in the stored manifest (reverse order, best-effort), then remove the
 * release secrets. Helm hooks are NOT executed — the UI states this.
 */
export async function uninstallRelease(handle: ClusterHandle, namespace: string, name: string, log: FastifyBaseLogger): Promise<UninstallResult> {
  const payload = await getLatestPayload(handle, namespace, name);
  const docs = loadAllYaml(payload.manifest ?? '').filter((d): d is Record<string, unknown> => !!d && typeof d === 'object');

  const result: UninstallResult = { deleted: [], failed: [] };
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

  for (const secret of await listReleaseSecretObjects(handle, namespace, name)) {
    try {
      await handle.core.deleteNamespacedSecret({ name: secret.metadata.name, namespace });
    } catch {
      // best-effort
    }
  }
  return result;
}
