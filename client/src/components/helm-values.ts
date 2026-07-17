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
