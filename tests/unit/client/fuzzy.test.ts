import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from '../../../client/src/fuzzy';

function score(query: string, text: string): number {
  const m = fuzzyMatch(query, text);
  if (!m) throw new Error(`expected "${query}" to match "${text}"`);
  return m.score;
}

describe('fuzzyMatch', () => {
  it('matches in-order subsequences', () => {
    expect(fuzzyMatch('kp', 'kind-prod')).not.toBeNull();
    expect(fuzzyMatch('kindprod', 'kind-prod')).not.toBeNull();
    expect(fuzzyMatch('dpl', 'deployments')).not.toBeNull();
  });

  it('rejects candidates missing characters or with wrong order', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull();
    expect(fuzzyMatch('ba', 'ab')).toBeNull();
    expect(fuzzyMatch('podz', 'pods')).toBeNull();
  });

  it('rejects queries longer than the candidate', () => {
    expect(fuzzyMatch('abcd', 'abc')).toBeNull();
    expect(fuzzyMatch('a', '')).toBeNull();
  });

  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('POD', 'my-pod')?.positions).toEqual([3, 4, 5]);
    expect(fuzzyMatch('pod', 'MY-POD')).not.toBeNull();
  });

  it('reports match positions for highlighting', () => {
    expect(fuzzyMatch('kp', 'kind-prod')?.positions).toEqual([0, 5]);
    expect(fuzzyMatch('abc', 'abc')?.positions).toEqual([0, 1, 2]);
  });

  it('hops to a boundary hit when the remainder still matches', () => {
    // plain hit for "p" is index 1, but the run reads better from "prod"
    expect(fuzzyMatch('pr', 'app-prod')?.positions).toEqual([4, 5]);
  });

  it('keeps a valid subsequence when the boundary hop would break it', () => {
    const m = fuzzyMatch('ac', 'xab-c-a');
    expect(m?.positions).toEqual([1, 4]);
  });

  it('ranks an acronym match above a scattered match', () => {
    expect(score('kpa', 'kind-prod-a')).toBeGreaterThan(score('kpa', 'kubernetes-paas-legacy'));
  });

  it('rewards consecutive runs', () => {
    expect(score('abc', 'abcxx')).toBeGreaterThan(score('abc', 'axbxc'));
  });

  it('rewards word-boundary hits', () => {
    expect(score('b', 'a-b')).toBeGreaterThan(score('b', 'aab'));
  });

  it('recognizes camelCase humps as boundaries', () => {
    expect(score('p', 'myPod')).toBeGreaterThan(score('p', 'mypod'));
    expect(fuzzyMatch('p', 'myPod')?.positions).toEqual([2]);
  });

  it('rewards matches that start early', () => {
    expect(score('web', 'web-frontend')).toBeGreaterThan(score('web', 'legacy-stack-web'));
  });

  it('penalizes long unmatched tails', () => {
    expect(score('pod', 'pod')).toBeGreaterThan(score('pod', 'pod-with-a-very-long-suffix'));
  });
});
