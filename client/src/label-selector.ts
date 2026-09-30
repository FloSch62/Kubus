/**
 * Helpers for comma-joined Kubernetes label selectors. Commas inside
 * parentheses belong to set-based terms (`env in (a,b)`) and are not
 * term separators.
 */

export function splitLabelSelector(selector: string): string[] {
  const terms: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of selector) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      const term = current.trim();
      if (term) terms.push(term);
      current = '';
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) terms.push(last);
  return terms;
}

export function joinLabelSelector(terms: string[]): string {
  return terms
    .flatMap((t) => {
      const trimmed = t.trim();
      return trimmed ? [trimmed] : [];
    })
    .join(',');
}

/** `label:app=web` typed into a search box, as the selector term it names. */
export function labelTermFromInput(input: string): string | undefined {
  const term = /^label:\s*(.+)$/i.exec(input.trim())?.[1]?.trim();
  return term || undefined;
}

/** A label key: `app`, `app.kubernetes.io/name`. Starts and ends alphanumeric, so `/app` (a smart filter) is not one. */
const LABEL_KEY = '[A-Za-z0-9](?:[\\w./-]*[A-Za-z0-9])?';
const NEGATED_KEY_RE = new RegExp(`^!${LABEL_KEY}$`);
const EQUALITY_RE = new RegExp(`^${LABEL_KEY}\\s*(==?|!=)\\s*[\\w.-]+$`);
const SET_RE = new RegExp(`^${LABEL_KEY}\\s+(in|notin)\\s+\\([^)]*\\)$`);
const BARE_KEY_RE = new RegExp(`^${LABEL_KEY}$`);

/** Text that reads as a raw selector term: `key=value`, `key!=value`, `!key`, `key in (a,b)`. */
export function looksLikeLabelSelector(text: string): boolean {
  const t = text.trim();
  return NEGATED_KEY_RE.test(t) || EQUALITY_RE.test(t) || SET_RE.test(t);
}

/**
 * Selector terms typed as-is (Enter in the search box or the picker's
 * selector field): `label:` prefixed text, or comma-joined raw terms that
 * each read as a selector. A bare key only counts when `bareKeys` is set,
 * since a plain word in the search box is a text search.
 */
export function typedLabelTerms(input: string, { bareKeys = false } = {}): string[] | undefined {
  const text = labelTermFromInput(input) ?? input.trim();
  // `/app=web` is a smart-filter clause, never a selector.
  if (!text || text.startsWith('/')) return undefined;
  const explicit = text !== input.trim() || bareKeys;
  const terms = splitLabelSelector(text);
  const valid = terms.every((t) => looksLikeLabelSelector(t) || (explicit && BARE_KEY_RE.test(t)));
  return valid && terms.length ? terms : undefined;
}

export interface LabelKeyCount {
  key: string;
  /** Rows carrying the key. */
  count: number;
  /** Values seen for the key with how many rows carry each, most common first. */
  values: Array<{ value: string; count: number }>;
}

/** Label keys and values across rows with row counts, most common keys first. */
export function countLabelPairs(labels: Iterable<Record<string, string> | undefined>): LabelKeyCount[] {
  const byKey = new Map<string, { count: number; values: Map<string, number> }>();
  for (const entry of labels) {
    for (const [key, value] of Object.entries(entry ?? {})) {
      let slot = byKey.get(key);
      if (!slot) byKey.set(key, (slot = { count: 0, values: new Map() }));
      slot.count++;
      slot.values.set(value, (slot.values.get(value) ?? 0) + 1);
    }
  }
  return [...byKey]
    .map(([key, { count, values }]) => ({
      key,
      count,
      values: [...values].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface LabelTermSuggestion {
  term: string;
  /** `key`: has the label; `pair`: key=value seen in the rows; `selector`: the typed text as-is. */
  kind: 'key' | 'pair' | 'selector';
}

/** Every label key with the values seen for it, collected once per row set. */
export function collectLabelPairs(labels: Iterable<Record<string, string> | undefined>): Map<string, Set<string>> {
  const pairs = new Map<string, Set<string>>();
  for (const entry of labels) {
    for (const [key, value] of Object.entries(entry ?? {})) {
      let values = pairs.get(key);
      if (!values) pairs.set(key, (values = new Set()));
      values.add(value);
    }
  }
  return pairs;
}

/**
 * Label terms matching typed text, best first: exact, then prefix, then
 * substring matches, shorter terms first. Terms already in the selector are
 * left out. A query that reads as a raw selector is offered as-is on top.
 */
export function labelTermSuggestions(pairs: Map<string, Set<string>>, input: string, existing: readonly string[], limit = 6): LabelTermSuggestion[] {
  const query = (labelTermFromInput(input) ?? input).trim();
  const q = query.toLowerCase();
  const taken = new Set(existing);
  const scored: Array<LabelTermSuggestion & { rank: number }> = [];
  const consider = (term: string, kind: 'key' | 'pair') => {
    if (taken.has(term)) return;
    const t = term.toLowerCase();
    const rank = !q ? 2 : t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : -1;
    if (rank >= 0) scored.push({ term, kind, rank });
  };
  for (const [key, values] of pairs) {
    consider(key, 'key');
    for (const value of values) consider(value ? `${key}=${value}` : key, 'pair');
  }
  scored.sort((a, b) => a.rank - b.rank || a.term.length - b.term.length || a.term.localeCompare(b.term));
  const seen = new Set<string>();
  const out: LabelTermSuggestion[] = [];
  if (query && looksLikeLabelSelector(query) && !taken.has(query) && !scored.some((s) => s.term === query)) {
    out.push({ term: query, kind: 'selector' });
    seen.add(query);
  }
  for (const s of scored) {
    if (out.length >= limit) break;
    if (seen.has(s.term)) continue;
    seen.add(s.term);
    out.push({ term: s.term, kind: s.kind });
  }
  return out;
}

/** Add one term (e.g. `app=nginx`) unless the selector already contains it. */
export function addLabelTerm(selector: string, term: string): string {
  const terms = splitLabelSelector(selector);
  if (terms.includes(term)) return selector;
  return joinLabelSelector([...terms, term]);
}
