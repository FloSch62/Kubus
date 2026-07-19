import { dump, loadAll } from 'js-yaml';

/** Stable, comment-free YAML for semantic values comparisons. */
export function canonicalValuesYaml(values: Record<string, unknown>): string {
  return dump(values, { noRefs: true, sortKeys: true, lineWidth: -1 });
}

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

/** Merge overrides onto defaults. An explicit null is kept: it is the user's "drop this default" marker. */
function mergeValues(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? mergeValues(existing, value) : value;
  }
  return out;
}

/**
 * Re-base an edited values text onto a new chart version's defaults: keep only
 * the user's own changes (relative to the old defaults) and apply them on top
 * of the new defaults. Without this, switching versions submits every
 * old-vs-new default delta as a user override. Returns undefined when any of
 * the three texts does not parse.
 */
export function rebaseValuesText(editedText: string, oldDefaultsText: string, newDefaultsText: string): string | undefined {
  const edited = parseValues(editedText);
  const oldDefaults = parseValues(oldDefaultsText);
  const newDefaults = parseValues(newDefaultsText);
  if (edited.error || oldDefaults.error || newDefaults.error) return undefined;
  const overrides = valuesOverrides(oldDefaults.values!, edited.values!);
  // No edits: show the new defaults verbatim, keeping the chart's comments.
  if (!Object.keys(overrides).length) return newDefaultsText;
  return dump(mergeValues(newDefaults.values!, overrides), { noRefs: true, lineWidth: -1 });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  // js-yaml parses unquoted YAML 1.1 timestamps into Dates; comparing them as
  // plain objects would make every pair "equal" and drop the edit.
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
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
