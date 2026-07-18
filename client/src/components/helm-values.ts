import { loadAll } from 'js-yaml';

/**
 * Parse user-supplied helm values YAML. Empty, whitespace-only and
 * comment-only input all mean "no overrides" ({}) — js-yaml's load() throws
 * on those, so this goes through loadAll(), which returns no documents.
 */
export function parseValues(text: string): { values?: Record<string, unknown>; error?: string } {
  try {
    const docs = loadAll(text).filter((d) => d !== null && d !== undefined);
    if (docs.length === 0) return { values: {} };
    if (docs.length > 1) return { error: 'values must be a single YAML document' };
    const parsed = docs[0];
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'values must be a YAML mapping' };
    return { values: parsed as Record<string, unknown> };
  } catch (err) {
    return { error: `values YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Keep only values that differ from chart defaults, preserving Helm override semantics. */
export function valuesOverrides(defaults: Record<string, unknown>, edited: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edited)) {
    const defaultValue = defaults[key];
    if (isPlainObject(value) && isPlainObject(defaultValue)) {
      const nested = valuesOverrides(defaultValue, value);
      if (Object.keys(nested).length) out[key] = nested;
    } else if (!deepEqual(value, defaultValue)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * User override paths absent from a candidate chart's defaults. These are
 * compatibility hints, not hard errors: charts may intentionally accept
 * arbitrary maps.
 */
export function unknownValuePaths(values: Record<string, unknown>, defaults: Record<string, unknown>, prefix = ''): string[] {
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(defaults, key)) {
      unknown.push(path);
      continue;
    }
    const candidate = defaults[key];
    if (isPlainObject(value) && isPlainObject(candidate) && Object.keys(candidate).length > 0) {
      unknown.push(...unknownValuePaths(value, candidate, path));
    }
  }
  return unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}
