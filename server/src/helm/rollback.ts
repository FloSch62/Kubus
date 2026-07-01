import type { FastifyBaseLogger } from 'fastify';
import type { KubernetesObject } from '@kubernetes/client-node';
import type { HelmRollbackResult } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem } from '../util/errors.js';
import { dumpYaml, loadAllYaml } from '../util/yaml.js';
import { decodeReleaseSecret, encodeReleasePayload, listReleaseSecretsRaw, type HelmReleasePayload, type ReleaseSecret } from './release-reader.js';

function revOf(secret: ReleaseSecret): number {
  return Number(/\.v(\d+)$/.exec(secret.metadata.name)?.[1] ?? 0);
}

/** RFC3339 with the local UTC offset — matches how helm stamps last_deployed. */
function rfc3339Local(date: Date): string {
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

function manifestDocs(manifest: string | undefined, defaultNamespace: string): KubernetesObject[] {
  return loadAllYaml(manifest ?? '')
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => d as unknown as KubernetesObject)
    .filter((obj) => !!obj.kind && !!obj.metadata?.name)
    .map((obj) => {
      obj.metadata!.namespace ??= defaultNamespace;
      return obj;
    });
}

function docKey(obj: KubernetesObject): string {
  return `${obj.apiVersion ?? ''}|${obj.kind ?? ''}|${obj.metadata?.namespace ?? ''}|${obj.metadata?.name ?? ''}`;
}

function docLabel(obj: KubernetesObject): string {
  return `${obj.kind}/${obj.metadata?.namespace ?? ''}/${obj.metadata?.name}`;
}

/** Resolve the list path for a manifest doc via API discovery (kind → plural, scope). */
async function pathForDoc(handle: ClusterHandle, obj: KubernetesObject): Promise<string> {
  const apiVersion = obj.apiVersion ?? 'v1';
  const [group, version] = apiVersion.includes('/') ? (apiVersion.split('/') as [string, string]) : ['', apiVersion];
  const all = await handle.discovery.getResources();
  const info = all.find((r) => r.group === group && r.version === version && r.kind === obj.kind);
  if (!info) throw new HttpProblem(422, `unknown kind ${apiVersion}/${obj.kind}`);
  return resourcePath(group, version, info.plural, {
    namespace: info.namespaced ? obj.metadata?.namespace : undefined,
    name: obj.metadata?.name,
    query: new URLSearchParams({ fieldManager: 'kubus', force: 'true' }),
  });
}

/** Update a release secret's payload and status label in place. */
async function patchReleaseSecret(handle: ClusterHandle, namespace: string, secretName: string, payload: HelmReleasePayload): Promise<void> {
  await handle.raw.json(resourcePath('', 'v1', 'secrets', { namespace, name: secretName }), {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({
      stringData: { release: encodeReleasePayload(payload) },
      metadata: { labels: { status: payload.info?.status ?? 'unknown' } },
    }),
  });
}

/**
 * Roll a release back to an earlier revision the way the helm CLI does:
 * re-apply the stored manifest of the target revision (server-side apply),
 * prune resources only present in the current revision, mark previously
 * deployed records superseded and write a new release record vN+1.
 * Helm hooks are NOT executed — the UI states this.
 */
export async function rollbackRelease(handle: ClusterHandle, namespace: string, name: string, toRevision: number, log: FastifyBaseLogger): Promise<HelmRollbackResult> {
  const secrets = await listReleaseSecretsRaw(handle, namespace, name);
  if (!secrets.length) throw new HttpProblem(404, `helm release "${namespace}/${name}" not found`);
  secrets.sort((a, b) => revOf(b) - revOf(a));
  const latestSecret = secrets[0]!;
  const latestRev = revOf(latestSecret);
  if (toRevision >= latestRev) throw new HttpProblem(422, `revision ${toRevision} is not older than the current revision ${latestRev}`);
  const targetSecret = secrets.find((s) => revOf(s) === toRevision);
  if (!targetSecret) throw new HttpProblem(404, `revision ${toRevision} not found`);

  // Deep-copy: decodeReleaseSecret caches payloads and they must not be mutated.
  const target = JSON.parse(JSON.stringify(decodeReleaseSecret(targetSecret))) as HelmReleasePayload;
  const latest = decodeReleaseSecret(latestSecret);

  const result: HelmRollbackResult = { newRevision: latestRev + 1, applied: [], pruned: [], failed: [] };

  // 1. Re-apply the target revision's manifest (create-or-update per doc).
  const targetDocs = manifestDocs(target.manifest, namespace);
  for (const doc of targetDocs) {
    const label = docLabel(doc);
    try {
      const path = await pathForDoc(handle, doc);
      const res = await handle.raw.request(path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/apply-patch+yaml' },
        body: dumpYaml(doc, { noRefs: true }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim());
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
      await handle.objects.delete(doc);
      result.pruned.push(label);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 404) {
        result.pruned.push(label);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ label, err: message }, 'helm rollback: prune failed');
        result.failed.push({ resource: label, error: message });
      }
    }
  }

  // 3. Mark previously deployed records superseded.
  for (const secret of secrets) {
    const payload = decodeReleaseSecret(secret);
    if (payload.info?.status !== 'deployed') continue;
    const superseded = JSON.parse(JSON.stringify(payload)) as HelmReleasePayload;
    superseded.info = { ...superseded.info, status: 'superseded' };
    try {
      await patchReleaseSecret(handle, namespace, secret.metadata.name, superseded);
    } catch (err) {
      log.warn({ secret: secret.metadata.name, err: String(err) }, 'helm rollback: superseded update failed');
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
  await handle.core.createNamespacedSecret({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'helm.sh/release.v1',
      metadata: {
        name: `sh.helm.release.v1.${name}.v${latestRev + 1}`,
        namespace,
        labels: {
          name,
          owner: 'helm',
          status: 'deployed',
          version: String(latestRev + 1),
          modifiedAt: String(Math.floor(Date.now() / 1000)),
        },
      },
      stringData: { release: encodeReleasePayload(newPayload) },
    },
  });

  return result;
}
