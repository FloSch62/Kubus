import zlib from 'node:zlib';
import type { HelmReleaseDetail, HelmReleaseSummary, HelmRevision, KubeObject } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem } from '../util/errors.js';
import { loadAllYaml } from '../util/yaml.js';
import type { HelmHookPayload } from './engine.js';

/** Decoded payload of a sh.helm.release.v1 record. */
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
    metadata?: {
      name?: string;
      version?: string;
      appVersion?: string;
      home?: string;
      sources?: string[];
      dependencies?: Array<{ name?: string; version?: string; repository?: string }>;
    };
    values?: Record<string, unknown>;
    /** Chart files (base64 data) — crds/ entries let uninstall offer CRD cleanup. */
    files?: Array<{ name?: string; data?: string }>;
  };
  config?: Record<string, unknown>;
  manifest?: string;
  hooks?: HelmHookPayload[];
  /** Kubus-only metadata; unknown JSON fields are ignored by the Helm CLI. */
  kubus?: {
    /** Exact values coalesced by Helm's renderer, including subcharts. */
    computedValues?: Record<string, unknown>;
  };
}

/** Helm storage backend a release record lives in. */
export type StorageDriver = 'secret' | 'configmap';

export interface ReleaseRecord {
  driver: StorageDriver;
  metadata: { name: string; namespace?: string; resourceVersion?: string; labels?: Record<string, string> };
  data?: { release?: string };
}

// Decode cache keyed by record name+resourceVersion (payloads are immutable per RV).
const decodeCache = new Map<string, HelmReleasePayload>();
const DECODE_CACHE_MAX = 200;

const RELEASE_RECORD_NAME_RE = /^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/;
const REVISION_SUFFIX_RE = /\.v(\d+)$/;

/**
 * Helm release payload: gzip(JSON), base64-encoded by helm. Secrets carry an
 * extra base64 layer added by the Kubernetes API; configmaps store the helm
 * base64 directly.
 */
export function decodeReleaseRecord(record: ReleaseRecord): HelmReleasePayload {
  const cacheKey = `${record.driver}:${record.metadata.namespace}/${record.metadata.name}@${record.metadata.resourceVersion ?? ''}`;
  const cached = decodeCache.get(cacheKey);
  if (cached) return cached;

  const raw = record.data?.release;
  if (!raw) throw new HttpProblem(422, `release record ${record.metadata.name} has no data.release`);
  const helmB64 = record.driver === 'secret' ? Buffer.from(raw, 'base64').toString('utf8') : raw;
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
 * Inverse of decodeReleaseRecord, minus the secret driver's outer base64:
 * returns base64(gzip(JSON)). Secrets take it via stringData (the API server
 * applies the outer base64); configmaps store it in data as-is.
 */
export function encodeReleasePayload(payload: HelmReleasePayload): string {
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
}

interface RecordList {
  items?: Array<{ metadata: ReleaseRecord['metadata']; data?: { release?: string } }>;
}

export async function listReleaseRecords(handle: ClusterHandle, namespace?: string, releaseName?: string): Promise<ReleaseRecord[]> {
  const query = () => new URLSearchParams({ labelSelector: releaseName ? `owner=helm,name=${releaseName}` : 'owner=helm' });
  const [secrets, configmaps] = await Promise.all([
    handle.raw.json<RecordList>(resourcePath('', 'v1', 'secrets', { namespace, query: query() })),
    // The configmap driver is rare; failure to list must not break helm views.
    handle.raw.json<RecordList>(resourcePath('', 'v1', 'configmaps', { namespace, query: query() })).catch(() => ({ items: [] }) as RecordList),
  ]);
  const tag = (items: RecordList['items'], driver: StorageDriver): ReleaseRecord[] =>
    (items ?? [])
      .filter((r) => r.metadata.name.startsWith('sh.helm.release.v1.'))
      .map((r) => ({ driver, metadata: r.metadata, data: r.data }));
  return [...tag(secrets.items, 'secret'), ...tag(configmaps.items, 'configmap')];
}

function summarize(payload: HelmReleasePayload, driver: StorageDriver): HelmReleaseSummary {
  return {
    name: payload.name,
    namespace: payload.namespace,
    revision: payload.version,
    status: payload.info?.status ?? 'unknown',
    chart: payload.chart?.metadata?.name ?? '',
    chartVersion: payload.chart?.metadata?.version ?? '',
    appVersion: payload.chart?.metadata?.appVersion,
    updated: payload.info?.last_deployed,
    driver,
  };
}

export async function listReleases(handle: ClusterHandle, namespace?: string): Promise<HelmReleaseSummary[]> {
  const records = await listReleaseRecords(handle, namespace);
  // Group by release, keep highest revision; revision is in the record name
  // (".vN" suffix) so we can pick the latest before decoding anything else.
  const latest = new Map<string, { record: ReleaseRecord; rev: number }>();
  for (const record of records) {
    const m = RELEASE_RECORD_NAME_RE.exec(record.metadata.name);
    if (!m) continue;
    const key = `${record.metadata.namespace}/${m[1]}`;
    const rev = Number(m[2]);
    const prev = latest.get(key);
    if (!prev || rev > prev.rev) latest.set(key, { record, rev });
  }
  const out: HelmReleaseSummary[] = [];
  for (const { record } of latest.values()) {
    try {
      out.push(summarize(decodeReleaseRecord(record), record.driver));
    } catch {
      // skip undecodable records
    }
  }
  return out.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
}

/** Names of the CRDs shipped in the chart's crds/ directory (stored in the release record). */
export function chartCrdNames(payload: HelmReleasePayload): string[] {
  const names: string[] = [];
  for (const file of payload.chart?.files ?? []) {
    if (!file.name?.startsWith('crds/') || !file.data) continue;
    try {
      for (const doc of loadAllYaml(Buffer.from(file.data, 'base64').toString('utf8'))) {
        const obj = doc as { kind?: string; metadata?: { name?: string } } | null;
        if (obj?.kind === 'CustomResourceDefinition' && obj.metadata?.name) names.push(obj.metadata.name);
      }
    } catch {
      // unparsable crds file — skip
    }
  }
  return names.sort();
}

function toDetail(payload: HelmReleasePayload, driver: StorageDriver): HelmReleaseDetail {
  return {
    ...summarize(payload, driver),
    notes: payload.info?.notes,
    values: payload.config ?? {},
    computedValues: payload.kubus?.computedValues ?? deepMerge(payload.chart?.values ?? {}, payload.config ?? {}),
    defaultValues: payload.chart?.values ?? {},
    chartHome: payload.chart?.metadata?.home,
    chartSources: payload.chart?.metadata?.sources ?? [],
    manifest: payload.manifest ?? '',
    firstDeployed: payload.info?.first_deployed,
    description: payload.info?.description,
    chartDependencies: payload.chart?.metadata?.dependencies?.length ?? 0,
    hookCount: payload.hooks?.length ?? 0,
    chartCrds: chartCrdNames(payload),
  };
}

export async function getRelease(handle: ClusterHandle, namespace: string, name: string): Promise<HelmReleaseDetail> {
  const { record, payload } = await getLatestRecord(handle, namespace, name);
  return toDetail(payload, record.driver);
}

/** Full detail of one specific revision — backs the revision diff. */
export async function getRevisionDetail(handle: ClusterHandle, namespace: string, name: string, revision: number): Promise<HelmReleaseDetail> {
  const records = await listReleaseRecords(handle, namespace, name);
  const record = records.find((r) => revOf(r) === revision);
  if (!record) throw new HttpProblem(404, `revision ${revision} of helm release "${namespace}/${name}" not found`);
  return toDetail(decodeReleaseRecord(record), record.driver);
}

export async function getLatestRecord(handle: ClusterHandle, namespace: string, name: string): Promise<{ record: ReleaseRecord; payload: HelmReleasePayload }> {
  const records = await listReleaseRecords(handle, namespace, name);
  if (!records.length) throw new HttpProblem(404, `helm release "${namespace}/${name}" not found`);
  let latest = records[0]!;
  let latestRev = revOf(latest);
  for (let i = 1; i < records.length; i++) {
    const rev = revOf(records[i]!);
    if (rev > latestRev) {
      latest = records[i]!;
      latestRev = rev;
    }
  }
  return { record: latest, payload: decodeReleaseRecord(latest) };
}

export async function getLatestPayload(handle: ClusterHandle, namespace: string, name: string): Promise<HelmReleasePayload> {
  return (await getLatestRecord(handle, namespace, name)).payload;
}

export async function getHistory(handle: ClusterHandle, namespace: string, name: string): Promise<HelmRevision[]> {
  const records = await listReleaseRecords(handle, namespace, name);
  if (!records.length) throw new HttpProblem(404, `helm release "${namespace}/${name}" not found`);
  return records
    .map((r): HelmRevision => {
      try {
        const payload = decodeReleaseRecord(r);
        return {
          revision: payload.version,
          status: payload.info?.status ?? 'unknown',
          chart: payload.chart?.metadata?.name ?? '',
          chartVersion: payload.chart?.metadata?.version ?? '',
          appVersion: payload.chart?.metadata?.appVersion,
          updated: payload.info?.last_deployed,
          description: payload.info?.description,
        };
      } catch {
        // One corrupt record must not take down the whole history (or the
        // rollback picker built on it) — surface it instead of hiding it.
        return {
          revision: revOf(r),
          status: r.metadata.labels?.status ?? 'unknown',
          chart: '',
          chartVersion: '',
          description: 'release record could not be decoded',
        };
      }
    })
    .sort((a, b) => b.revision - a.revision);
}

export async function listReleaseRecordObjects(handle: ClusterHandle, namespace: string, name: string): Promise<Array<KubeObject & { driver: StorageDriver }>> {
  const records = await listReleaseRecords(handle, namespace, name);
  return records as unknown as Array<KubeObject & { driver: StorageDriver }>;
}

export function revOf(record: { metadata: { name: string } }): number {
  return Number(REVISION_SUFFIX_RE.exec(record.metadata.name)?.[1] ?? 0);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    // Helm's coalescing removes a default when the user explicitly supplies
    // null; retaining it here would make the release detail disagree with the
    // values used during template rendering.
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(existing) && isPlainObject(value)) {
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
