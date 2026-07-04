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

/** Add one term (e.g. `app=nginx`) unless the selector already contains it. */
export function addLabelTerm(selector: string, term: string): string {
  const terms = splitLabelSelector(selector);
  if (terms.includes(term)) return selector;
  return joinLabelSelector([...terms, term]);
}
