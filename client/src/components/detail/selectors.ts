/** Kubernetes label selectors as the API expresses them, plus their kubectl-style text form. */

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
}

/** `app=web,tier in (a,b),!legacy` — the selector as a kubectl `-l` argument. */
export function labelSelectorToString(selector: LabelSelector | undefined): string {
  if (!selector) return '';
  const parts = Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`);
  for (const expr of selector.matchExpressions ?? []) {
    if (expr.operator === 'In') parts.push(`${expr.key} in (${(expr.values ?? []).join(',')})`);
    else if (expr.operator === 'NotIn') parts.push(`${expr.key} notin (${(expr.values ?? []).join(',')})`);
    else if (expr.operator === 'Exists') parts.push(expr.key);
    else if (expr.operator === 'DoesNotExist') parts.push(`!${expr.key}`);
  }
  return parts.join(',');
}

/** Whether labels satisfy a selector (matchLabels and matchExpressions). */
export function labelSelectorMatches(selector: LabelSelector | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector) return false;
  const have = labels ?? {};
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (have[key] !== value) return false;
  }
  for (const expr of selector.matchExpressions ?? []) {
    const actual = have[expr.key];
    switch (expr.operator) {
      case 'In':
        if (actual === undefined || !(expr.values ?? []).includes(actual)) return false;
        break;
      case 'NotIn':
        if (actual !== undefined && (expr.values ?? []).includes(actual)) return false;
        break;
      case 'Exists':
        if (actual === undefined) return false;
        break;
      case 'DoesNotExist':
        if (actual !== undefined) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}
