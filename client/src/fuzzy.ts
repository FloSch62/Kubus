/**
 * Small dependency-free fuzzy matcher (fzf-style subsequence matching).
 *
 * Every query character must appear in order in the candidate. The score
 * rewards matches at word boundaries, consecutive runs, and early positions,
 * so "kpa" ranks "kind-prod-a" above "kubernetes-paas-legacy".
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the candidate string that matched, for highlighting. */
  positions: number[];
}

const BOUNDARY = /[\s\-_./:@]/;

function isBoundaryStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  if (BOUNDARY.test(prev)) return true;
  // camelCase hump
  return prev === prev.toLowerCase() && text[i] !== text[i]!.toLowerCase();
}

/** Whether q[qi..] appears in order in t starting at or after ti. */
function remainderMatches(q: string, qi: number, t: string, ti: number): boolean {
  for (let i = qi; i < q.length; i++) {
    ti = t.indexOf(q[i]!, ti);
    if (ti === -1) return false;
    ti += 1;
  }
  return true;
}

/**
 * Match `query` against `text`; returns null when not every query character
 * appears in order. Case-insensitive. Greedy left-to-right with a boundary
 * lookahead: prefer starting a run at a word boundary over a mid-word hit
 * one position earlier, which is what users expect from context names like
 * "gke_team_europe-west1_prod".
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q.length) return { score: 0, positions: [] };
  if (q.length > t.length) return null;

  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = t.indexOf(ch, ti);
    if (found === -1) return null;
    // If the plain hit is mid-word, a slightly later boundary hit is better —
    // but only when the rest of the query still matches after the hop, so a
    // valid subsequence is never discarded (e.g. "ac" in "xab-c-a").
    if (!isBoundaryStart(text, found) && (!positions.length || found !== positions[positions.length - 1]! + 1)) {
      for (let i = found + 1; i < Math.min(t.length, found + 24); i++) {
        if (t[i] === ch && isBoundaryStart(text, i) && remainderMatches(q, qi + 1, t, i + 1)) {
          found = i;
          break;
        }
      }
    }
    const consecutive = positions.length > 0 && found === positions[positions.length - 1]! + 1;
    score += 1;
    if (consecutive) score += 4;
    if (isBoundaryStart(text, found)) score += 6;
    positions.push(found);
    ti = found + 1;
  }
  // Prefer matches that start early and leave little unmatched tail.
  score += Math.max(0, 8 - positions[0]!);
  score -= Math.floor((text.length - q.length) / 8);
  return { score, positions };
}
