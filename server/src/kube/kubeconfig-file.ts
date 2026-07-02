import fs from 'node:fs';
import path from 'node:path';
import { KubeConfig } from '@kubernetes/client-node';
import { HttpProblem } from '../util/errors.js';
import { dumpYaml, loadYaml } from '../util/yaml.js';

interface NamedEntry {
  name: string;
  [key: string]: unknown;
}

interface KubeconfigDoc {
  apiVersion?: string;
  kind?: string;
  'current-context'?: string;
  clusters?: NamedEntry[];
  users?: NamedEntry[];
  contexts?: NamedEntry[];
  [key: string]: unknown;
}

export interface MergeResult {
  merged: string;
  added: { contexts: string[]; clusters: string[]; users: string[] };
  skipped: string[];
  conflicts: string[];
}

function asEntries(value: unknown): NamedEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is NamedEntry => !!e && typeof e === 'object' && typeof (e as NamedEntry).name === 'string');
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge a pasted kubeconfig into an existing one, by entry name. The raw YAML
 * objects are merged (not KubeConfig.exportConfig output) so unknown fields
 * and the existing file's structure are preserved faithfully.
 */
export function mergeKubeconfig(existingYaml: string | null, incomingYaml: string, overwrite: boolean): MergeResult {
  // Validate with the real parser first: garbage in → 400 out.
  const probe = new KubeConfig();
  try {
    probe.loadFromString(incomingYaml);
  } catch (err) {
    throw new HttpProblem(400, `not a valid kubeconfig: ${err instanceof Error ? err.message : String(err)}`, 'BadRequest');
  }
  if (probe.getContexts().length === 0) {
    throw new HttpProblem(400, 'kubeconfig contains no contexts', 'BadRequest');
  }

  const incoming = (loadYaml(incomingYaml) ?? {}) as KubeconfigDoc;
  const existing: KubeconfigDoc | null = existingYaml?.trim() ? ((loadYaml(existingYaml) ?? {}) as KubeconfigDoc) : null;

  const added = { contexts: [] as string[], clusters: [] as string[], users: [] as string[] };
  const skipped: string[] = [];
  const conflicts: string[] = [];

  if (!existing) {
    const doc: KubeconfigDoc = {
      apiVersion: incoming.apiVersion ?? 'v1',
      kind: incoming.kind ?? 'Config',
      ...incoming,
    };
    if (!doc['current-context']) doc['current-context'] = asEntries(incoming.contexts)[0]?.name;
    added.contexts = asEntries(incoming.contexts).map((e) => e.name);
    added.clusters = asEntries(incoming.clusters).map((e) => e.name);
    added.users = asEntries(incoming.users).map((e) => e.name);
    return { merged: dumpYaml(doc, { lineWidth: -1 }), added, skipped, conflicts };
  }

  for (const section of ['clusters', 'users', 'contexts'] as const) {
    const target = asEntries(existing[section]);
    for (const entry of asEntries(incoming[section])) {
      const idx = target.findIndex((e) => e.name === entry.name);
      const label = `${section.slice(0, -1)}/${entry.name}`;
      if (idx === -1) {
        target.push(entry);
        added[section].push(entry.name);
      } else if (deepEqual(target[idx], entry)) {
        skipped.push(label);
      } else if (overwrite) {
        target[idx] = entry;
        added[section].push(entry.name);
      } else {
        conflicts.push(label);
      }
    }
    existing[section] = target;
  }

  // Never touch current-context of an existing file.
  return { merged: dumpYaml(existing, { lineWidth: -1 }), added, skipped, conflicts };
}

export interface ClusterEditPatch {
  server: string;
  skipTlsVerify: boolean;
  caPem: string | null;
  proxyUrl: string | null;
  tlsServerName: string | null;
  auth: { method: 'keep' } | { method: 'token'; token: string } | { method: 'client-cert'; clientCertPem: string; clientKeyPem: string };
}

type AuthEditPatch = Exclude<ClusterEditPatch['auth'], { method: 'keep' }>;

function loadDoc(existingYaml: string): KubeconfigDoc {
  return (loadYaml(existingYaml) ?? {}) as KubeconfigDoc;
}

function dumpDoc(doc: KubeconfigDoc): string {
  return dumpYaml(doc, { lineWidth: -1 });
}

function setString(obj: Record<string, unknown>, key: string, value: string | null): void {
  if (value === null || value.trim() === '') delete obj[key];
  else obj[key] = value.trim();
}

/**
 * Accept certificate material as PEM *or* as the base64 `*-data` value copied
 * out of another kubeconfig — a very easy mix-up that otherwise lands
 * double-encoded in the file and fails with cryptic OpenSSL PEM errors.
 */
function normalizePem(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('-----BEGIN')) return trimmed;
  const decoded = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8');
  return decoded.includes('-----BEGIN') ? decoded.trim() : trimmed;
}

function pemToData(pem: string): string {
  return Buffer.from(`${normalizePem(pem)}\n`).toString('base64');
}

/**
 * Edit an existing context's cluster + user in place: update server/TLS/proxy
 * and optionally CA and credentials. Untouched fields (and the user's auth when
 * `auth.method === 'keep'`, e.g. exec/auth-provider plugins) are preserved, as
 * is the file's overall structure. Returns the new YAML.
 */
export function patchCluster(existingYaml: string, contextName: string, patch: ClusterEditPatch): string {
  const doc = loadDoc(existingYaml);
  const ctxEntry = asEntries(doc.contexts).find((e) => e.name === contextName);
  if (!ctxEntry) throw new HttpProblem(404, `context "${contextName}" not found in kubeconfig`, 'NotFound');
  const ctxBody = (ctxEntry.context ?? {}) as { cluster?: string; user?: string };
  let next = patchClusterEntry(existingYaml, ctxBody.cluster, patch);
  if (patch.auth.method !== 'keep') next = patchUserEntry(next, ctxBody.user, patch.auth);
  return next;
}

export function patchClusterEntry(existingYaml: string, clusterName: string | undefined, patch: ClusterEditPatch): string {
  const doc = loadDoc(existingYaml);
  if (!clusterName) throw new HttpProblem(400, 'context has no cluster reference', 'BadRequest');
  const clusterEntry = asEntries(doc.clusters).find((e) => e.name === clusterName);
  if (!clusterEntry) throw new HttpProblem(404, `cluster "${clusterName}" not found in kubeconfig`, 'NotFound');
  const cluster = (clusterEntry.cluster && typeof clusterEntry.cluster === 'object' ? clusterEntry.cluster : (clusterEntry.cluster = {})) as Record<
    string,
    unknown
  >;

  cluster.server = patch.server.trim();
  setString(cluster, 'proxy-url', patch.proxyUrl);
  setString(cluster, 'tls-server-name', patch.tlsServerName);
  if (patch.skipTlsVerify) {
    cluster['insecure-skip-tls-verify'] = true;
    delete cluster['certificate-authority'];
    delete cluster['certificate-authority-data'];
  } else {
    delete cluster['insecure-skip-tls-verify'];
    if (patch.caPem && patch.caPem.trim()) {
      cluster['certificate-authority-data'] = pemToData(patch.caPem);
      delete cluster['certificate-authority'];
    }
  }

  return dumpDoc(doc);
}

export function patchUserEntry(existingYaml: string, userName: string | undefined, patch: AuthEditPatch): string {
  const doc = loadDoc(existingYaml);
  if (!userName) throw new HttpProblem(400, "context has no user reference, so credentials can't be edited", 'BadRequest');
  const userEntry = asEntries(doc.users).find((e) => e.name === userName);
  if (!userEntry) throw new HttpProblem(404, `user "${userName}" not found in kubeconfig`, 'NotFound');
  const user = (userEntry.user && typeof userEntry.user === 'object' ? userEntry.user : (userEntry.user = {})) as Record<string, unknown>;
  // Switching auth method makes the chosen credentials authoritative.
  for (const k of ['token', 'client-certificate', 'client-certificate-data', 'client-key', 'client-key-data', 'exec', 'auth-provider', 'username', 'password']) {
    delete user[k];
  }
  if (patch.method === 'token') {
    user.token = patch.token.trim();
  } else {
    user['client-certificate-data'] = pemToData(patch.clientCertPem);
    user['client-key-data'] = pemToData(patch.clientKeyPem);
  }

  return dumpDoc(doc);
}

/**
 * Write the merged kubeconfig: rolling backup of the previous file, then an
 * atomic tmp+rename write. Returns the backup path (null if nothing existed).
 */
export function writeKubeconfig(targetPath: string, content: string): string | null {
  let backupPath: string | null = null;
  let mode = 0o600;
  if (fs.existsSync(targetPath)) {
    try {
      mode = fs.statSync(targetPath).mode & 0o777;
    } catch {
      /* keep default */
    }
    backupPath = `${targetPath}.kubus.bak`;
    fs.copyFileSync(targetPath, backupPath);
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }
  const tmp = `${targetPath}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, targetPath);
  return backupPath;
}
