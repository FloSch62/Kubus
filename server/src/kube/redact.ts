import type { KubeObject } from '@kubus/shared';

export const REDACTED = '••••••••';

export function isSecretGVR(group: string, plural: string): boolean {
  return group === '' && plural === 'secrets';
}

/**
 * Replace Secret data values with a placeholder before objects leave the
 * server. Callers decide WHEN via the GVR (list items omit kind/apiVersion,
 * so shape-sniffing is unreliable). Helm release secrets are redacted too —
 * the helm module reads them through its own raw path, and their payloads
 * can embed credentials in chart values.
 */
export function redactSecretData<T extends KubeObject>(obj: T): T {
  const clone = { ...obj } as T & { data?: Record<string, unknown>; stringData?: Record<string, unknown> };
  if (clone.data && typeof clone.data === 'object') {
    clone.data = Object.fromEntries(Object.keys(clone.data).map((k) => [k, REDACTED]));
  }
  if (clone.stringData && typeof clone.stringData === 'object') {
    clone.stringData = Object.fromEntries(Object.keys(clone.stringData).map((k) => [k, REDACTED]));
  }
  return clone;
}

/** Redact when the GVR is the core secrets resource; pass through otherwise. */
export function maybeRedact<T extends KubeObject>(obj: T, group: string, plural: string): T {
  return isSecretGVR(group, plural) ? redactSecretData(obj) : obj;
}
