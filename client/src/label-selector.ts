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

/** Text that reads as a raw selector term: `key=value`, `key!=value`, `!key`, `key in (a,b)`. */
export function looksLikeLabelSelector(text: string): boolean {
  const t = text.trim();
  return /^![\w./-]+$/.test(t) || /^[\w./-]+\s*(==?|!=)\s*[\w./-]+$/.test(t) || /^[\w./-]+\s+(in|notin)\s+\([^)]*\)$/.test(t);
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
