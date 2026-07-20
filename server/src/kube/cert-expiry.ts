import { X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';
import type { CertExpiryEntry, KubeObject, OverviewCertificates } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resolveCrd } from './operator-rollups.js';
import { optionalItems } from './overview.js';

const EXPIRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const API_SERVER_CERT_TTL_MS = 60 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 3_000;

/**
 * notAfter per TLS secret, keyed by `uid@resourceVersion` so the x509 parse
 * runs once per secret revision, not on every overview poll.
 */
const secretNotAfterCache = new Map<string, string | undefined>();
const SECRET_CACHE_MAX = 10_000;

function tlsSecretNotAfter(secret: KubeObject): string | undefined {
  const key = `${secret.metadata.uid}@${secret.metadata.resourceVersion ?? ''}`;
  if (secretNotAfterCache.has(key)) return secretNotAfterCache.get(key);
  if (secretNotAfterCache.size > SECRET_CACHE_MAX) secretNotAfterCache.clear();
  let notAfter: string | undefined;
  try {
    const b64 = (secret.data as Record<string, string> | undefined)?.['tls.crt'];
    if (b64) {
      const pem = Buffer.from(b64, 'base64').toString('utf8');
      // The leaf certificate is the first block by convention.
      const block = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
      if (block) notAfter = new Date(new X509Certificate(block).validTo).toISOString();
    }
  } catch {
    // Garbage in the secret — treat as unknown.
  }
  secretNotAfterCache.set(key, notAfter);
  return notAfter;
}

/**
 * Certificate expiry rollup: cert-manager Certificates (when the CRD is
 * installed) plus kubernetes.io/tls Secrets, deduped so a cert-manager-owned
 * secret doesn't count its Certificate twice.
 */
export async function collectCertificates(handle: ClusterHandle, crds: KubeObject[], namespaces?: ReadonlySet<string>): Promise<OverviewCertificates> {
  const inScope = (o: KubeObject) => !namespaces || namespaces.has(o.metadata.namespace ?? '');
  const now = Date.now();
  const expiring: CertExpiryEntry[] = [];
  let total = 0;

  const push = (entry: CertExpiryEntry) => {
    const t = Date.parse(entry.notAfter);
    if (!Number.isNaN(t) && t - now < EXPIRY_WINDOW_MS) expiring.push(entry);
  };

  const certCrd = resolveCrd(new Map(crds.map((c) => [c.metadata.name, c])), 'certificates.cert-manager.io');
  const collectedCerts = new Set<string>();
  if (certCrd) {
    const acquired = handle.watchers.acquire(certCrd.group, certCrd.version, certCrd.plural);
    try {
      const result = await optionalItems(acquired.watcher);
      for (const cert of result.items) {
        if (!inScope(cert)) continue;
        total += 1;
        collectedCerts.add(`${cert.metadata.namespace ?? ''}/${cert.metadata.name}`);
        const notAfter = (cert.status as { notAfter?: string } | undefined)?.notAfter;
        if (notAfter) {
          push({
            source: 'cert-manager',
            kind: certCrd.kind,
            group: certCrd.group,
            version: certCrd.version,
            plural: certCrd.plural,
            namespace: cert.metadata.namespace ?? '',
            name: cert.metadata.name,
            notAfter,
          });
        }
      }
    } finally {
      acquired.release();
    }
  }

  const secretsWatcher = handle.watchers.acquire('', 'v1', 'secrets');
  let secretsUnavailable = false;
  try {
    const result = await optionalItems(secretsWatcher.watcher);
    secretsUnavailable = result.unavailable;
    for (const secret of result.items) {
      if ((secret as { type?: string }).type !== 'kubernetes.io/tls' || !inScope(secret)) continue;
      // cert-manager stamps the secrets it manages — skip only when the
      // owning Certificate was actually collected above (RBAC may allow
      // Secrets but deny Certificates; then the Secret is our only view).
      const ownerCert = secret.metadata.annotations?.['cert-manager.io/certificate-name'];
      if (ownerCert && collectedCerts.has(`${secret.metadata.namespace ?? ''}/${ownerCert}`)) continue;
      total += 1;
      const notAfter = tlsSecretNotAfter(secret);
      if (notAfter) {
        push({
          source: 'tls-secret',
          kind: 'Secret',
          group: '',
          version: 'v1',
          plural: 'secrets',
          namespace: secret.metadata.namespace ?? '',
          name: secret.metadata.name,
          notAfter,
        });
      }
    }
  } finally {
    secretsWatcher.release();
  }

  expiring.sort((a, b) => a.notAfter.localeCompare(b.notAfter));
  return { total, expiring, secretsUnavailable: secretsUnavailable || undefined };
}

const apiServerCertCache = new WeakMap<ClusterHandle, { at: number; value?: string }>();

/**
 * Expiry of the API server's serving certificate, read from a TLS handshake.
 * Best-effort: proxied/tunneled clusters may not be directly reachable —
 * then the overview simply omits it. Cached for an hour per handle.
 */
export async function apiServerCertNotAfter(handle: ClusterHandle): Promise<string | undefined> {
  const cached = apiServerCertCache.get(handle);
  if (cached && Date.now() - cached.at < API_SERVER_CERT_TTL_MS) return cached.value;

  const server = handle.kc.getCurrentCluster()?.server;
  let value: string | undefined;
  if (server) {
    try {
      const url = new URL(server);
      if (url.protocol === 'https:') {
        value = await new Promise<string | undefined>((resolve) => {
          const socket = tls.connect(
            {
              host: url.hostname,
              port: Number(url.port || 443),
              servername: url.hostname,
              rejectUnauthorized: false,
              timeout: HANDSHAKE_TIMEOUT_MS,
            },
            () => {
              const cert = socket.getPeerCertificate();
              socket.end();
              resolve(cert?.valid_to ? new Date(cert.valid_to).toISOString() : undefined);
            },
          );
          socket.on('timeout', () => {
            socket.destroy();
            resolve(undefined);
          });
          socket.on('error', () => resolve(undefined));
        });
      }
    } catch {
      value = undefined;
    }
  }
  apiServerCertCache.set(handle, { at: Date.now(), value });
  return value;
}
