import { describe, expect, it } from 'vitest';
import { addLabelTerm, joinLabelSelector, splitLabelSelector } from '../../../client/src/label-selector';

describe('splitLabelSelector', () => {
  it('splits on top-level commas', () => {
    expect(splitLabelSelector('a=b,c=d')).toEqual(['a=b', 'c=d']);
    expect(splitLabelSelector('app=nginx')).toEqual(['app=nginx']);
  });

  it('keeps commas inside parentheses with their set-based term', () => {
    expect(splitLabelSelector('env in (a,b),tier=web')).toEqual(['env in (a,b)', 'tier=web']);
    expect(splitLabelSelector('a notin (x,y,z)')).toEqual(['a notin (x,y,z)']);
    expect(splitLabelSelector('env in (a,b),team notin (c,d)')).toEqual(['env in (a,b)', 'team notin (c,d)']);
  });

  it('trims whitespace and drops empty terms', () => {
    expect(splitLabelSelector(' a=b , , c=d ')).toEqual(['a=b', 'c=d']);
    expect(splitLabelSelector('a=b,')).toEqual(['a=b']);
    expect(splitLabelSelector(',a=b')).toEqual(['a=b']);
  });

  it('returns nothing for an empty selector', () => {
    expect(splitLabelSelector('')).toEqual([]);
    expect(splitLabelSelector('  ')).toEqual([]);
  });

  it('tolerates an unbalanced open paren by not splitting inside it', () => {
    expect(splitLabelSelector('env in (a,b')).toEqual(['env in (a,b']);
  });

  it('clamps extra closing parens instead of going negative', () => {
    expect(splitLabelSelector('a),b=c')).toEqual(['a)', 'b=c']);
  });
});

describe('joinLabelSelector', () => {
  it('joins terms with commas', () => {
    expect(joinLabelSelector(['a=b', 'c=d'])).toBe('a=b,c=d');
  });

  it('trims terms and drops empties', () => {
    expect(joinLabelSelector([' a=b ', '', '  ', 'c=d'])).toBe('a=b,c=d');
    expect(joinLabelSelector([])).toBe('');
  });
});

describe('addLabelTerm', () => {
  it('appends to an existing selector', () => {
    expect(addLabelTerm('a=b', 'c=d')).toBe('a=b,c=d');
  });

  it('starts a selector from empty', () => {
    expect(addLabelTerm('', 'app=nginx')).toBe('app=nginx');
  });

  it('returns the selector unchanged when the term is already present', () => {
    expect(addLabelTerm('a=b,c=d', 'c=d')).toBe('a=b,c=d');
    // untouched including original spacing
    expect(addLabelTerm(' a=b , c=d ', 'c=d')).toBe(' a=b , c=d ');
  });

  it('handles set-based terms with commas', () => {
    expect(addLabelTerm('env in (a,b)', 'tier=web')).toBe('env in (a,b),tier=web');
    expect(addLabelTerm('env in (a,b),tier=web', 'env in (a,b)')).toBe('env in (a,b),tier=web');
  });
});
