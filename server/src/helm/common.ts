import type { KubernetesObject } from '@kubernetes/client-node';
import type { Response } from 'node-fetch';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem } from '../util/errors.js';
import { dumpYaml, loadAllYaml } from '../util/yaml.js';
import { encodeReleasePayload, type HelmReleasePayload, type StorageDriver } from './release-reader.js';

/** RFC3339 with the local UTC offset — matches how helm stamps last_deployed. */
export function rfc3339Local(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function manifestDocs(manifest: string | undefined, defaultNamespace: string): KubernetesObject[] {
  return loadAllYaml(manifest ?? '')
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => d as unknown as KubernetesObject)
    .filter((obj) => !!obj.kind && !!obj.metadata?.name)
    .map((obj) => {
      obj.metadata!.namespace ??= defaultNamespace;
      return obj;
    });
}

/**
 * Release-membership identity for prune matching. Helm matches resources
 * across revisions by kind + namespace + name, deliberately ignoring
 * group/version: an apiVersion migration must not delete the object that was
 * just applied under the new version.
 */
export function docKey(obj: KubernetesObject): string {
  return `${obj.kind ?? ''}|${obj.metadata?.namespace ?? ''}|${obj.metadata?.name ?? ''}`;
}

export function docLabel(obj: KubernetesObject): string {
  return `${obj.kind}/${obj.metadata?.namespace ?? ''}/${obj.metadata?.name}`;
}

/** Resolve the object path for a manifest doc via API discovery (kind → plural, scope). */
export async function pathForDoc(handle: ClusterHandle, obj: KubernetesObject, forApply = true): Promise<string> {
  const apiVersion = obj.apiVersion ?? 'v1';
  const [group, version] = apiVersion.includes('/') ? (apiVersion.split('/') as [string, string]) : ['', apiVersion];
  const all = await handle.discovery.getResources();
  const info = all.find((r) => r.group === group && r.version === version && r.kind === obj.kind);
  if (!info) throw new HttpProblem(422, `unknown kind ${apiVersion}/${obj.kind}`);
  // manifestDocs gives unqualified resources the release namespace. Strip it
  // again for cluster-scoped kinds: Kubernetes rejects metadata.namespace on
  // ClusterRoles, Namespaces, CRDs, and other cluster-wide objects.
  if (!info.namespaced && obj.metadata?.namespace) delete obj.metadata.namespace;
  return resourcePath(group, version, info.plural, {
    namespace: info.namespaced ? obj.metadata?.namespace : undefined,
    name: obj.metadata?.name,
    query: forApply ? new URLSearchParams({ fieldManager: 'kubus', force: 'true' }) : undefined,
  });
}

/**
 * Create one manifest doc without updating an object that already exists.
 * The POST/409 result is an atomic existence check, avoiding the race between
 * a separate GET and create. This matches Helm's handling of chart CRDs.
 */
export async function createDocIfAbsent(handle: ClusterHandle, doc: KubernetesObject): Promise<boolean> {
  const apiVersion = doc.apiVersion ?? 'v1';
  const [group, version] = apiVersion.includes('/') ? (apiVersion.split('/') as [string, string]) : ['', apiVersion];
  const all = await handle.discovery.getResources();
  const info = all.find((resource) => resource.group === group && resource.version === version && resource.kind === doc.kind);
  if (!info) throw new HttpProblem(422, `unknown kind ${apiVersion}/${doc.kind}`);
  if (!info.namespaced && doc.metadata?.namespace) delete doc.metadata.namespace;
  const path = resourcePath(group, version, info.plural, {
    namespace: info.namespaced ? doc.metadata?.namespace : undefined,
  });
  const res = await handle.raw.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  });
  if (res.status === 409) {
    await res.arrayBuffer().catch(() => undefined);
    return false;
  }
  if (!res.ok) throw new Error(`${res.status} ${await responseMessage(res)}`.trim());
  await res.arrayBuffer().catch(() => undefined);
  return true;
}

/** Server-side apply in Kubernetes dry-run mode; nothing is persisted. */
export async function validateDoc(handle: ClusterHandle, doc: KubernetesObject): Promise<void> {
  const path = await pathForDoc(handle, doc);
  const separator = path.includes('?') ? '&' : '?';
  const res = await handle.raw.request(`${path}${separator}dryRun=All`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/apply-patch+yaml' },
    body: dumpYaml(doc, { noRefs: true }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await responseMessage(res)}`.trim());
}

/** Server-side apply one manifest doc; throws with the API server's message on failure. */
export async function applyDoc(handle: ClusterHandle, doc: KubernetesObject): Promise<void> {
  const path = await pathForDoc(handle, doc);
  const res = await handle.raw.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/apply-patch+yaml' },
    body: dumpYaml(doc, { noRefs: true }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await responseMessage(res)}`.trim());
}

async function responseMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { message?: string };
    return body.message ?? text;
  } catch {
    return text;
  }
}

/** Delete one manifest doc; 404 counts as success. Returns false when it was already gone. */
export async function deleteDoc(handle: ClusterHandle, doc: KubernetesObject): Promise<boolean> {
  // Resolve scope through discovery just like apply does. manifestDocs assigns
  // the release namespace to unqualified objects; pathForDoc removes it again
  // for ClusterRoles, CRDs, Namespaces, and all other cluster-scoped kinds.
  const path = await pathForDoc(handle, doc, false);
  const res = await handle.raw.request(path, { method: 'DELETE' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`${res.status} ${await responseMessage(res)}`.trim());
  return true;
}

/** Update a release record's payload and status label in place. */
export async function patchReleaseRecord(handle: ClusterHandle, namespace: string, recordName: string, payload: HelmReleasePayload, driver: StorageDriver = 'secret'): Promise<void> {
  const encoded = encodeReleasePayload(payload);
  await handle.raw.json(resourcePath('', 'v1', driver === 'secret' ? 'secrets' : 'configmaps', { namespace, name: recordName }), {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({
      // The API server base64-encodes secret stringData; configmaps store the helm base64 directly.
      ...(driver === 'secret' ? { stringData: { release: encoded } } : { data: { release: encoded } }),
      metadata: { labels: { status: payload.info?.status ?? 'unknown' } },
    }),
  });
}

/** Create the sh.helm.release.v1.<name>.v<rev> record for a payload. */
export async function createReleaseRecord(handle: ClusterHandle, payload: HelmReleasePayload, driver: StorageDriver = 'secret'): Promise<string> {
  const name = `sh.helm.release.v1.${payload.name}.v${payload.version}`;
  const metadata = {
    name,
    namespace: payload.namespace,
    labels: {
      name: payload.name,
      owner: 'helm',
      status: payload.info?.status ?? 'unknown',
      version: String(payload.version),
      modifiedAt: String(Math.floor(Date.now() / 1000)),
    },
  };
  const encoded = encodeReleasePayload(payload);
  if (driver === 'secret') {
    await handle.core.createNamespacedSecret({
      namespace: payload.namespace,
      body: { apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata, stringData: { release: encoded } },
    });
  } else {
    await handle.core.createNamespacedConfigMap({
      namespace: payload.namespace,
      body: { apiVersion: 'v1', kind: 'ConfigMap', metadata, data: { release: encoded } },
    });
  }
  return name;
}

/** Cluster capabilities for template rendering: kube version + every group/version and group/version/Kind. */
export async function clusterCapabilities(handle: ClusterHandle): Promise<{ kubeVersion?: string; apiVersions: string[] }> {
  const versions = new Set<string>();
  const resources = await handle.discovery.getResources();
  for (const r of resources) {
    const gv = r.group ? `${r.group}/${r.version}` : r.version;
    versions.add(gv);
    versions.add(`${gv}/${r.kind}`);
  }
  let kubeVersion: string | undefined;
  try {
    const info = await handle.raw.json<{ gitVersion?: string }>('/version');
    kubeVersion = info.gitVersion;
  } catch {
    // capabilities fall back to the engine's built-in default kube version
  }
  return { kubeVersion, apiVersions: [...versions].sort() };
}
