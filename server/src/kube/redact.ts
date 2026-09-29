import { createHmac, randomBytes } from 'node:crypto';
import type { KubeObject } from '@kubus/shared';

export const REDACTED = '••••••••';

export function isSecretGVR(group: string, plural: string): boolean {
  return group === '' && plural === 'secrets';
}

/**
 * `kubectl apply` keeps the whole applied manifest in this annotation, Secret
 * data included, so it is masked along with the data itself.
 */
export const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';

type SecretShape = KubeObject & { data?: Record<string, unknown>; stringData?: Record<string, unknown> };

function maskValues(map: Record<string, unknown> | undefined, mask: (value: unknown) => string): Record<string, unknown> | undefined {
  if (!map || typeof map !== 'object') return map;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, mask(v)]));
}

function maskSecret<T extends KubeObject>(obj: T, mask: (value: unknown) => string): T {
  const clone = { ...obj } as T & SecretShape;
  if (clone.data && typeof clone.data === 'object') clone.data = maskValues(clone.data, mask);
  if (clone.stringData && typeof clone.stringData === 'object') clone.stringData = maskValues(clone.stringData, mask);
  const lastApplied = clone.metadata?.annotations?.[LAST_APPLIED_ANNOTATION];
  if (typeof lastApplied === 'string') {
    let masked: string;
    try {
      const applied = JSON.parse(lastApplied) as SecretShape;
      masked = JSON.stringify({ ...applied, data: maskValues(applied.data, mask), stringData: maskValues(applied.stringData, mask) });
    } catch {
      // Unparsable: nothing in it can be told apart from a value, so hide it all.
      masked = REDACTED;
    }
    clone.metadata = { ...clone.metadata, annotations: { ...clone.metadata.annotations, [LAST_APPLIED_ANNOTATION]: masked } };
  }
  return clone;
}

/**
 * Replace Secret data values with a placeholder before objects leave the
 * server. Callers decide WHEN via the GVR (list items omit kind/apiVersion,
 * so shape-sniffing is unreliable). Helm release secrets are redacted too —
 * the helm module reads them through its own raw path, and their payloads
 * can embed credentials in chart values.
 */
export function redactSecretData<T extends KubeObject>(obj: T): T {
  return maskSecret(obj, () => REDACTED);
}

// Fingerprints are keyed per server process: two values compare equal within
// one run, but a fingerprint can't be brute-forced offline for short secrets.
const FINGERPRINT_KEY = randomBytes(32);

/** Short keyed fingerprint of one Secret value, e.g. `•••••••• #3f9a1c2e`. */
export function secretFingerprint(value: unknown): string {
  const digest = createHmac('sha256', FINGERPRINT_KEY).update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
  return `${REDACTED} #${digest.slice(0, 8)}`;
}

/**
 * Like redactSecretData, but each value becomes a keyed fingerprint so a
 * diff can tell which keys differ without either side's value leaving the
 * server.
 */
export function fingerprintSecretData<T extends KubeObject>(obj: T): T {
  return maskSecret(obj, secretFingerprint);
}

/** Redact when the GVR is the core secrets resource; pass through otherwise. */
export function maybeRedact<T extends KubeObject>(obj: T, group: string, plural: string): T {
  return isSecretGVR(group, plural) ? redactSecretData(obj) : obj;
}
