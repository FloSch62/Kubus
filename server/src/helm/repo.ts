import type { HelmChartHit, HelmChartSummary, HelmChartUpdate, HelmChartVersion, HelmHubChart, HelmRepo, HelmUpdateCheck } from '@kubus/shared';
import type { SettingsStore } from '../settings-store.js';
import { HttpProblem } from '../util/errors.js';
import { loadYaml } from '../util/yaml.js';

/**
 * Chart repository access without the helm binary: classic HTTP repos via
 * index.yaml, plus anonymous pulls from OCI registries (oci:// refs).
 */

const INDEX_TTL_MS = 10 * 60 * 1000;
const INDEX_MAX_BYTES = 100 * 1024 * 1024;
const CHART_MAX_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

interface IndexVersionEntry {
  name?: string;
  version?: string;
  appVersion?: string;
  description?: string;
  icon?: string;
  created?: string | Date;
  digest?: string;
  urls?: string[];
  deprecated?: boolean;
  home?: string;
  keywords?: string[];
}

interface RepoIndex {
  entries?: Record<string, IndexVersionEntry[]>;
}

// Bounded: keyed by user-supplied repo URLs, and one parsed big index is tens
// of MB — unbounded growth would eventually take the process down.
const INDEX_CACHE_MAX = 20;
const indexCache = new Map<string, { fetchedAt: number; index: RepoIndex }>();

function boundCache<T>(cache: Map<string, T>, max: number, oldestFirst: (a: T, b: T) => number): void {
  if (cache.size <= max) return;
  for (const [key] of [...cache.entries()].sort((a, b) => oldestFirst(a[1], b[1])).slice(0, cache.size - max)) {
    cache.delete(key);
  }
}

function normalizeRepoUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function listRepos(settings: SettingsStore): HelmRepo[] {
  const repos = settings.load().helmRepos;
  // settings.json is hand-editable; malformed entries must not 500 every repo route.
  if (!Array.isArray(repos)) return [];
  return repos.filter((r): r is HelmRepo => !!r && typeof r === 'object' && typeof r.name === 'string' && typeof r.url === 'string');
}

export async function addRepo(settings: SettingsStore, name: string, url: string): Promise<HelmRepo> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new HttpProblem(422, 'repository name may only contain letters, digits, ".", "_" and "-"');
  const normalized = normalizeRepoUrl(url);
  if (!/^https?:\/\//.test(normalized)) throw new HttpProblem(422, 'repository URL must be http(s) — OCI registries are used via direct oci:// refs, no repository entry needed');
  if (listRepos(settings).some((r) => r.name === name)) throw new HttpProblem(409, `repository "${name}" already exists`);
  await fetchIndex(normalized); // validates the URL actually serves an index.yaml
  // Re-read after the (up to 60s) index fetch: saving the pre-fetch snapshot
  // would silently drop a repo added concurrently.
  const repos = listRepos(settings);
  if (repos.some((r) => r.name === name)) throw new HttpProblem(409, `repository "${name}" already exists`);
  const repo: HelmRepo = { name, url: normalized };
  settings.save({ helmRepos: [...repos, repo] });
  return repo;
}

export function removeRepo(settings: SettingsStore, name: string): void {
  const repos = listRepos(settings);
  if (!repos.some((r) => r.name === name)) throw new HttpProblem(404, `repository "${name}" not found`);
  settings.save({ helmRepos: repos.filter((r) => r.name !== name) });
}

export function getRepo(settings: SettingsStore, name: string): HelmRepo {
  const repo = listRepos(settings).find((r) => r.name === name);
  if (!repo) throw new HttpProblem(404, `repository "${name}" not found`);
  return repo;
}

async function fetchBytes(url: string, opts?: { accept?: string; token?: string; maxBytes?: number }): Promise<{ body: Buffer; contentType: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        ...(opts?.accept ? { accept: opts.accept } : {}),
        ...(opts?.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
    });
  } catch (err) {
    throw new HttpProblem(502, `fetch ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const max = opts?.maxBytes ?? CHART_MAX_BYTES;
  const overLimit = () => new HttpProblem(413, `${url} exceeds ${Math.round(max / 1e6)}MB limit`);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpProblem(res.status === 404 ? 404 : 502, `fetch ${url}: HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw overLimit();
  }
  // Enforce the limit while streaming: buffering first would let a hostile or
  // broken server feed gigabytes into memory before any check runs.
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      const buf = Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > max) throw overLimit();
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof HttpProblem) throw err;
    throw new HttpProblem(502, `fetch ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { body: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' };
}

async function fetchIndex(repoUrl: string): Promise<RepoIndex> {
  const cached = indexCache.get(repoUrl);
  if (cached && Date.now() - cached.fetchedAt < INDEX_TTL_MS) return cached.index;
  const { body } = await fetchBytes(`${repoUrl}/index.yaml`, { maxBytes: INDEX_MAX_BYTES });
  const parsed = loadYaml(body.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || !('entries' in parsed)) {
    throw new HttpProblem(422, `${repoUrl}/index.yaml is not a helm repository index`);
  }
  const index = parsed as RepoIndex;
  indexCache.set(repoUrl, { fetchedAt: Date.now(), index });
  boundCache(indexCache, INDEX_CACHE_MAX, (a, b) => a.fetchedAt - b.fetchedAt);
  return index;
}

/** Descending semver-ish sort; tolerates non-semver tags by falling back to string compare. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! > pb.nums[i]! ? -1 : 1;
    }
    // A release has higher precedence than its pre-release.
    if (!pa.pre && pb.pre) return -1;
    if (pa.pre && !pb.pre) return 1;
    if (!pa.pre || !pb.pre) return 0;
    return comparePrereleaseDesc(pa.pre, pb.pre);
  }
  return b.localeCompare(a, undefined, { numeric: true });
}

function comparePrereleaseDesc(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right) ? -1 : 1;
    // Numeric identifiers have lower precedence than non-numeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? 1 : -1;
    // Valid SemVer identifiers are ASCII, so code-unit order is ASCII order.
    return left > right ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  // With an equal prefix, the version with more identifiers is newer.
  return a.length > b.length ? -1 : 1;
}

function parseSemver(v: string): { nums: bigint[]; pre?: string[] } | undefined {
  const m =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      v.trim(),
    );
  if (!m) return undefined;
  const pre = m[4]?.split('.');
  // Numeric pre-release identifiers with leading zeroes are not valid SemVer.
  if (pre?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return undefined;
  return { nums: [BigInt(m[1]!), BigInt(m[2]!), BigInt(m[3]!)], pre };
}

function isPrerelease(v: string): boolean {
  return !!parseSemver(v)?.pre;
}

function toChartVersion(e: IndexVersionEntry): HelmChartVersion {
  return {
    version: e.version ?? '',
    appVersion: e.appVersion,
    description: e.description,
    created: e.created instanceof Date ? e.created.toISOString() : e.created,
    deprecated: e.deprecated || undefined,
  };
}

export async function listCharts(repo: HelmRepo): Promise<HelmChartSummary[]> {
  const index = await fetchIndex(repo.url);
  const out: HelmChartSummary[] = [];
  for (const [name, versions] of Object.entries(index.entries ?? {})) {
    if (!Array.isArray(versions) || !versions.length) continue;
    const latest = [...versions].sort((a, b) => compareVersionsDesc(a.version ?? '', b.version ?? ''))[0]!;
    out.push({
      repo: repo.name,
      name,
      description: latest.description,
      icon: latest.icon,
      version: latest.version ?? '',
      appVersion: latest.appVersion,
      deprecated: latest.deprecated || undefined,
      keywords: latest.keywords?.slice(0, 8),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listChartVersions(repo: HelmRepo, chart: string): Promise<HelmChartVersion[]> {
  const index = await fetchIndex(repo.url);
  const versions = index.entries?.[chart];
  if (!versions?.length) throw new HttpProblem(404, `chart "${chart}" not found in repository "${repo.name}"`);
  return [...versions].sort((a, b) => compareVersionsDesc(a.version ?? '', b.version ?? '')).map(toChartVersion);
}

/**
 * Find a chart by exact name for the upgrade version picker: every configured
 * repo first, then Artifact Hub (deduped against configured repo URLs), so any
 * chart resolves without the user hunting down its repository.
 */
export async function findChartInRepos(settings: SettingsStore, chart: string): Promise<HelmChartHit[]> {
  const results: HelmChartHit[] = [];
  const seenUrls = new Set<string>();
  const [, hubHits] = await Promise.all([
    Promise.all(
      listRepos(settings).map(async (repo) => {
        try {
          const index = await fetchIndex(repo.url);
          const versions = index.entries?.[chart];
          if (versions?.length) {
            seenUrls.add(normalizeRepoUrl(repo.url));
            results.push({
              repo: repo.name,
              versions: [...versions].sort((a, b) => compareVersionsDesc(a.version ?? '', b.version ?? '')).map(toChartVersion),
            });
          }
        } catch {
          // unreachable repo — skip silently, this is best-effort discovery
        }
      }),
    ),
    hubFindChart(chart).catch(() => [] as HelmChartHit[]),
  ]);
  results.sort((a, b) => a.repo.localeCompare(b.repo));
  for (const hit of hubHits) {
    if (hit.repoUrl && seenUrls.has(normalizeRepoUrl(hit.repoUrl))) continue;
    results.push(hit);
  }
  return results;
}

/**
 * Resolve safe update hints in a bounded number of parallel lookups. A source
 * is only trusted when it also publishes the installed version; this avoids
 * suggesting an unrelated chart that happens to share the same name.
 */
export async function checkChartUpdates(settings: SettingsStore, checks: HelmUpdateCheck[]): Promise<HelmChartUpdate[]> {
  const uniqueCharts = [...new Set(checks.map((item) => item.chart).filter(Boolean))];
  const hitsByChart = new Map<string, HelmChartHit[]>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, uniqueCharts.length) }, async () => {
    while (cursor < uniqueCharts.length) {
      const chart = uniqueCharts[cursor++]!;
      hitsByChart.set(chart, await findChartInRepos(settings, chart).catch(() => []));
    }
  });
  await Promise.all(workers);

  return checks.map((item) => {
    const hits = hitsByChart.get(item.chart) ?? [];
    if (!hits.length) {
      return { ...item, available: false, reason: 'chart-not-found' };
    }
    const versionMatches = hits.filter((hit) => hit.versions.some((version) => version.version === item.currentVersion));
    const source =
      (item.currentAppVersion
        ? versionMatches.find((hit) =>
            hit.versions.some((version) => version.version === item.currentVersion && version.appVersion === item.currentAppVersion),
          )
        : undefined) ?? versionMatches[0];
    if (!source) {
      return { ...item, available: false, reason: 'current-version-not-found' };
    }
    const allowPrerelease = isPrerelease(item.currentVersion);
    const latest = source.versions
      .filter((version) => !version.deprecated && (allowPrerelease || !isPrerelease(version.version)))
      .toSorted((a, b) => compareVersionsDesc(a.version, b.version))[0];
    if (!latest || compareVersionsDesc(latest.version, item.currentVersion) >= 0) {
      return {
        ...item,
        available: false,
        latestVersion: latest?.version,
        latestAppVersion: latest?.appVersion,
        repo: source.repo,
        repoUrl: source.repoUrl,
        reason: 'up-to-date',
      };
    }
    return {
      ...item,
      available: true,
      latestVersion: latest.version,
      latestAppVersion: latest.appVersion,
      repo: source.repo,
      repoUrl: source.repoUrl,
    };
  });
}

/** Download a chart .tgz given its repository base URL (classic http(s) index repo or oci:// base). */
export async function fetchChartArchiveByRepoUrl(repoUrl: string, chart: string, version: string): Promise<Buffer> {
  if (repoUrl.startsWith('oci://')) {
    // Artifact Hub OCI "repositories" often point at the chart itself already.
    const base = normalizeRepoUrl(repoUrl);
    return pullOciChart(base.endsWith(`/${chart}`) ? base : `${base}/${chart}`, version);
  }
  const index = await fetchIndex(normalizeRepoUrl(repoUrl));
  const entry = index.entries?.[chart]?.find((e) => e.version === version);
  if (!entry) throw new HttpProblem(404, `chart "${chart}" version "${version}" not found in repository ${repoUrl}`);
  const rawUrl = entry.urls?.[0];
  if (!rawUrl) throw new HttpProblem(422, `chart "${chart}" ${version} has no archive URL in the index`);
  const resolved = rawUrl.startsWith('oci://') ? rawUrl : new URL(rawUrl, `${normalizeRepoUrl(repoUrl)}/`).toString();
  if (resolved.startsWith('oci://')) return pullOciChart(resolved, version);
  const { body } = await fetchBytes(resolved);
  return body;
}

/** Download a chart .tgz from a configured repo. */
export async function fetchChartArchive(repo: HelmRepo, chart: string, version: string): Promise<Buffer> {
  return fetchChartArchiveByRepoUrl(repo.url, chart, version);
}

// ---- Artifact Hub ----

const HUB_API = 'https://artifacthub.io/api/v1';
const HUB_TTL_MS = 10 * 60 * 1000;
const HUB_CACHE_MAX = 200;
const hubCache = new Map<string, { at: number; value: unknown }>();

async function hubJson<T>(path: string): Promise<T> {
  const cached = hubCache.get(path);
  if (cached && Date.now() - cached.at < HUB_TTL_MS) return cached.value as T;
  const { body } = await fetchBytes(`${HUB_API}${path}`, { accept: 'application/json', maxBytes: 10 * 1024 * 1024 });
  const value = JSON.parse(body.toString('utf8')) as T;
  hubCache.set(path, { at: Date.now(), value });
  boundCache(hubCache, HUB_CACHE_MAX, (a, b) => a.at - b.at);
  return value;
}

interface HubSearchResponse {
  packages?: Array<{
    name?: string;
    normalized_name?: string;
    description?: string;
    logo_image_id?: string;
    version?: string;
    app_version?: string;
    repository?: { name?: string; url?: string; verified_publisher?: boolean; official?: boolean };
  }>;
}

function toHubChart(p: NonNullable<HubSearchResponse['packages']>[number]): HelmHubChart | undefined {
  if (!p.name || !p.repository?.name || !p.repository.url) return undefined;
  return {
    name: p.name,
    repoName: p.repository.name,
    repoUrl: p.repository.url,
    description: p.description,
    icon: p.logo_image_id ? `https://artifacthub.io/image/${p.logo_image_id}` : undefined,
    version: p.version ?? '',
    appVersion: p.app_version,
    official: p.repository.official || undefined,
    verifiedPublisher: p.repository.verified_publisher || undefined,
  };
}

/** Free-text helm chart search on Artifact Hub. */
export async function searchHub(query: string, limit = 25): Promise<HelmHubChart[]> {
  const q = new URLSearchParams({ ts_query_web: query, kind: '0', limit: String(Math.min(limit, 50)), offset: '0' });
  const res = await hubJson<HubSearchResponse>(`/packages/search?${q.toString()}`);
  return (res.packages ?? []).map(toHubChart).filter((c): c is HelmHubChart => !!c);
}

interface HubPackageDetail {
  available_versions?: Array<{ version?: string; app_version?: string; prerelease?: boolean; ts?: number }>;
  repository?: { url?: string; name?: string };
}

/** All published versions of one Artifact Hub package. */
export async function hubChartVersions(repoName: string, chart: string): Promise<{ repoUrl: string; versions: HelmChartVersion[] }> {
  const detail = await hubJson<HubPackageDetail>(`/packages/helm/${encodeURIComponent(repoName)}/${encodeURIComponent(chart)}`);
  const repoUrl = detail.repository?.url;
  if (!repoUrl) throw new HttpProblem(404, `Artifact Hub package ${repoName}/${chart} not found`);
  const versions = (detail.available_versions ?? [])
    .filter((v): v is { version: string; app_version?: string; prerelease?: boolean; ts?: number } => !!v.version && !v.prerelease)
    .sort((a, b) => compareVersionsDesc(a.version, b.version))
    .map((v) => ({ version: v.version, appVersion: v.app_version, created: v.ts ? new Date(v.ts * 1000).toISOString() : undefined }));
  return { repoUrl, versions };
}

/** Exact-name chart lookup on Artifact Hub, versions included (top repos, official/verified first). */
async function hubFindChart(chart: string): Promise<HelmChartHit[]> {
  const matches = (await searchHub(chart, 25))
    .filter((c) => c.name === chart)
    .sort((a, b) => Number(b.official ?? false) - Number(a.official ?? false) || Number(b.verifiedPublisher ?? false) - Number(a.verifiedPublisher ?? false))
    .slice(0, 4);
  const hits = await Promise.all(
    matches.map(async (m): Promise<HelmChartHit | undefined> => {
      try {
        const { repoUrl, versions } = await hubChartVersions(m.repoName, chart);
        if (!versions.length) return undefined;
        return { repo: m.repoName, repoUrl, versions, fromHub: true };
      } catch {
        return undefined;
      }
    }),
  );
  return hits.filter((h): h is HelmChartHit => !!h);
}

/** Download a chart .tgz from a direct URL. */
export async function fetchChartByUrl(url: string): Promise<Buffer> {
  if (!/^https?:\/\//.test(url)) throw new HttpProblem(422, 'chart URL must be http(s)');
  const { body } = await fetchBytes(url);
  return body;
}

// ---- OCI ----

interface OciRef {
  host: string;
  repository: string;
  tag?: string;
}

// Distribution-spec charsets. The segments end up interpolated into registry
// URLs, so anything looser would let a ref smuggle "..", "?" or "#" into the
// request path (and break the repository:<repo>:pull token scope).
const OCI_HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d+)?$/;
const OCI_REPOSITORY_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const OCI_TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._+-]{0,127}$/;

export function parseOciRef(ref: string): OciRef {
  const m = /^oci:\/\/([^/]+)\/(.+?)(?::([^:/]+))?$/.exec(ref.trim());
  if (!m) throw new HttpProblem(422, `invalid OCI ref "${ref}" — expected oci://registry/repository[:tag]`);
  const [, host, repository, tag] = m as unknown as [string, string, string, string | undefined];
  if (!OCI_HOST_RE.test(host)) throw new HttpProblem(422, `invalid OCI registry host "${host}"`);
  if (!OCI_REPOSITORY_RE.test(repository)) throw new HttpProblem(422, `invalid OCI repository "${repository}"`);
  if (tag !== undefined && !OCI_TAG_RE.test(tag)) throw new HttpProblem(422, `invalid OCI tag "${tag}"`);
  return { host, repository, tag };
}

/** OCI tags forbid "+"; helm publishes semver build metadata with "_" instead. */
function ociTagFor(version: string): string {
  return version.replaceAll('+', '_');
}

/** Anonymous bearer-token dance: 401 → parse WWW-Authenticate → token endpoint. */
async function ociToken(host: string, repository: string): Promise<string | undefined> {
  let res: Response;
  try {
    res = await fetch(`https://${host}/v2/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new HttpProblem(502, `OCI registry ${host} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status !== 401) return undefined;
  const challenge = res.headers.get('www-authenticate') ?? '';
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  if (!realm) return undefined;
  const tokenUrl = new URL(realm);
  if (service) tokenUrl.searchParams.set('service', service);
  tokenUrl.searchParams.set('scope', `repository:${repository}:pull`);
  const tokenRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!tokenRes.ok) throw new HttpProblem(502, `OCI token request failed: HTTP ${tokenRes.status} (private registries are not supported yet)`);
  const data = (await tokenRes.json()) as { token?: string; access_token?: string };
  return data.token ?? data.access_token;
}

export async function listOciTags(ref: string): Promise<string[]> {
  const { host, repository } = parseOciRef(ref);
  const token = await ociToken(host, repository);
  const { body } = await fetchBytes(`https://${host}/v2/${repository}/tags/list?n=200`, { token, maxBytes: 10 * 1024 * 1024 });
  const data = JSON.parse(body.toString('utf8')) as { tags?: string[] };
  return (data.tags ?? []).sort(compareVersionsDesc);
}

const HELM_CHART_LAYER = 'application/vnd.cncf.helm.chart.content.v1.tar+gzip';

export async function pullOciChart(ref: string, version?: string): Promise<Buffer> {
  const { host, repository, tag } = parseOciRef(ref);
  const requested = version || tag;
  if (!requested) throw new HttpProblem(422, `OCI ref "${ref}" needs a version`);
  const useTag = ociTagFor(requested);
  if (!OCI_TAG_RE.test(useTag)) throw new HttpProblem(422, `invalid OCI tag "${requested}"`);
  const token = await ociToken(host, repository);
  const accept = 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json';
  const { body: manifestBody } = await fetchBytes(`https://${host}/v2/${repository}/manifests/${useTag}`, { token, accept, maxBytes: 10 * 1024 * 1024 });
  const manifest = JSON.parse(manifestBody.toString('utf8')) as {
    layers?: Array<{ mediaType?: string; digest?: string }>;
    manifests?: Array<{ digest?: string }>;
  };
  let layers = manifest.layers;
  if (!layers && manifest.manifests?.length) {
    // Image index → follow the first (charts publish a single manifest).
    const digest = manifest.manifests[0]!.digest!;
    const { body: subBody } = await fetchBytes(`https://${host}/v2/${repository}/manifests/${digest}`, { token, accept, maxBytes: 10 * 1024 * 1024 });
    layers = (JSON.parse(subBody.toString('utf8')) as { layers?: Array<{ mediaType?: string; digest?: string }> }).layers;
  }
  const chartLayer = layers?.find((l) => l.mediaType === HELM_CHART_LAYER);
  if (!chartLayer?.digest) throw new HttpProblem(422, `${ref}:${useTag} is not a helm chart (no ${HELM_CHART_LAYER} layer)`);
  const { body } = await fetchBytes(`https://${host}/v2/${repository}/blobs/${chartLayer.digest}`, { token });
  return body;
}
