import zlib from 'node:zlib';
import type { HelmReleaseDetail, HelmReleaseSummary, HelmRevision, KubeObject } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem } from '../util/errors.js';

/** Decoded payload of a sh.helm.release.v1 secret. */
export interface HelmReleasePayload {
  name: string;
  namespace: string;
  version: number;
  info?: {
    status?: string;
    first_deployed?: string;
    last_deployed?: string;
    deleted?: string;
    description?: string;
    notes?: string;
  };
  chart?: {
    metadata?: { name?: string; version?: string; appVersion?: string };
    values?: Record<string, unknown>;
  };
  config?: Record<string, unknown>;
  manifest?: string;
}

export interface ReleaseSecret {
  metadata: { name: string; namespace?: string; resourceVersion?: string; labels?: Record<string, string> };
  data?: { release?: string };
}

// Decode cache keyed by secret name+resourceVersion (payloads are immutable per RV).
const decodeCache = new Map<string, HelmReleasePayload>();
const DECODE_CACHE_MAX = 200;

/** Helm release payload: k8s base64 -> helm base64 -> gzip -> JSON. */
export function decodeReleaseSecret(secret: ReleaseSecret): HelmReleasePayload {
  const cacheKey = `${secret.metadata.namespace}/${secret.metadata.name}@${secret.metadata.resourceVersion ?? ''}`;
  const cached = decodeCache.get(cacheKey);
  if (cached) return cached;

  const raw = secret.data?.release;
  if (!raw) throw new HttpProblem(422, `release secret ${secret.metadata.name} has no data.release`);
  const helmB64 = Buffer.from(raw, 'base64').toString('utf8');
  const gz = Buffer.from(helmB64, 'base64');
  const json = zlib.gunzipSync(gz).toString('utf8');
  const payload = JSON.parse(json) as HelmReleasePayload;

  if (decodeCache.size >= DECODE_CACHE_MAX) {
    const first = decodeCache.keys().next().value;
    if (first) decodeCache.delete(first);
  }
  decodeCache.set(cacheKey, payload);
  return payload;
}

/**
 * Inverse of decodeReleaseSecret, minus the outer base64: returns
 * base64(gzip(JSON)) for use in a secret's stringData — the API server
 * applies the final base64 when storing it in data.
 */
export function encodeReleasePayload(payload: HelmReleasePayload): string {
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
}

export async function listReleaseSecretsRaw(handle: ClusterHandle, namespace?: string, releaseName?: string): Promise<ReleaseSecret[]> {
  return listReleaseSecrets(handle, namespace, releaseName);
}

async function listReleaseSecrets(handle: ClusterHandle, namespace?: string, releaseName?: string): Promise<ReleaseSecret[]> {
  const query = new URLSearchParams({ labelSelector: releaseName ? `owner=helm,name=${releaseName}` : 'owner=helm' });
  const path = resourcePath('', 'v1', 'secrets', { namespace, query });
  const list = await handle.raw.json<{ items?: ReleaseSecret[] }>(path);
  return (list.items ?? []).filter((s) => s.metadata.name.startsWith('sh.helm.release.v1.'));
}

function summarize(payload: HelmReleasePayload): HelmReleaseSummary {
  return {
    name: payload.name,
    namespace: payload.namespace,
    revision: payload.version,
    status: payload.info?.status ?? 'unknown',
    chart: payload.chart?.metadata?.name ?? '',
    chartVersion: payload.chart?.metadata?.version ?? '',
    appVersion: payload.chart?.metadata?.appVersion,
    updated: payload.info?.last_deployed,
  };
}

export async function listReleases(handle: ClusterHandle, namespace?: string): Promise<HelmReleaseSummary[]> {
  const secrets = await listReleaseSecrets(handle, namespace);
  // Group by release, keep highest revision; revision is in the secret name
  // (".vN" suffix) so we can pick the latest before decoding anything else.
  const latest = new Map<string, ReleaseSecret>();
  for (const secret of secrets) {
    const m = /^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/.exec(secret.metadata.name);
    if (!m) continue;
    const key = `${secret.metadata.namespace}/${m[1]}`;
    const prev = latest.get(key);
    const prevRev = prev ? Number(/\.v(\d+)$/.exec(prev.metadata.name)?.[1] ?? 0) : -1;
    if (Number(m[2]) > prevRev) latest.set(key, secret);
  }
  const out: HelmReleaseSummary[] = [];
  for (const secret of latest.values()) {
    try {
      out.push(summarize(decodeReleaseSecret(secret)));
    } catch {
      // skip undecodable secrets
    }
  }
  return out.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
}

export async function getRelease(handle: ClusterHandle, namespace: string, name: string): Promise<HelmReleaseDetail> {
  const payload = await getLatestPayload(handle, namespace, name);
  return {
    ...summarize(payload),
    notes: payload.info?.notes,
    values: payload.config ?? {},
    computedValues: deepMerge(payload.chart?.values ?? {}, payload.config ?? {}),
    manifest: payload.manifest ?? '',
    firstDeployed: payload.info?.first_deployed,
    description: payload.info?.description,
  };
}

/** Full detail of one specific revision — backs the revision diff. */
export async function getRevisionDetail(handle: ClusterHandle, namespace: string, name: string, revision: number): Promise<HelmReleaseDetail> {
  const secrets = await listReleaseSecrets(handle, namespace, name);
  const secret = secrets.find((s) => revOf(s) === revision);
  if (!secret) throw new HttpProblem(404, `revision ${revision} of helm release "${namespace}/${name}" not found`);
  const payload = decodeReleaseSecret(secret);
  return {
    ...summarize(payload),
    notes: payload.info?.notes,
    values: payload.config ?? {},
    computedValues: deepMerge(payload.chart?.values ?? {}, payload.config ?? {}),
    manifest: payload.manifest ?? '',
    firstDeployed: payload.info?.first_deployed,
    description: payload.info?.description,
  };
}

export async function getLatestPayload(handle: ClusterHandle, namespace: string, name: string): Promise<HelmReleasePayload> {
  const secrets = await listReleaseSecrets(handle, namespace, name);
  if (!secrets.length) throw new HttpProblem(404, `helm release "${namespace}/${name}" not found`);
  secrets.sort((a, b) => revOf(b) - revOf(a));
  return decodeReleaseSecret(secrets[0]!);
}

export async function getHistory(handle: ClusterHandle, namespace: string, name: string): Promise<HelmRevision[]> {
  const secrets = await listReleaseSecrets(handle, namespace, name);
  if (!secrets.length) throw new HttpProblem(404, `helm release "${namespace}/${name}" not found`);
  return secrets
    .map((s) => {
      const payload = decodeReleaseSecret(s);
      return {
        revision: payload.version,
        status: payload.info?.status ?? 'unknown',
        chart: payload.chart?.metadata?.name ?? '',
        chartVersion: payload.chart?.metadata?.version ?? '',
        appVersion: payload.chart?.metadata?.appVersion,
        updated: payload.info?.last_deployed,
        description: payload.info?.description,
      };
    })
    .sort((a, b) => b.revision - a.revision);
}

export async function listReleaseSecretObjects(handle: ClusterHandle, namespace: string, name: string): Promise<KubeObject[]> {
  const secrets = await listReleaseSecrets(handle, namespace, name);
  return secrets as unknown as KubeObject[];
}

function revOf(secret: ReleaseSecret): number {
  return Number(/\.v(\d+)$/.exec(secret.metadata.name)?.[1] ?? 0);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
