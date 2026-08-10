import { describe, expect, it } from 'vitest';
import { terminalRightClickIntent, xtermRightClickSelectsWord } from '../../../client/src/terminal-right-click';

describe('terminal right click', () => {
  it('preserves platform word selection only for an empty context menu', () => {
    expect(xtermRightClickSelectsWord(true, 'menu', false)).toBe(true);
    expect(xtermRightClickSelectsWord(true, 'menu', true)).toBe(false);
    expect(xtermRightClickSelectsWord(true, 'copy-paste', false)).toBe(false);
    expect(xtermRightClickSelectsWord(true, 'paste', false)).toBe(false);
    expect(xtermRightClickSelectsWord(false, 'menu', false)).toBe(false);
  });

  it('copies an existing selection in copy-paste mode', () => {
    expect(terminalRightClickIntent('copy-paste', 'selected output')).toEqual({ kind: 'copy', selection: 'selected output' });
  });

  it('pastes without a selection or when always-paste mode is enabled', () => {
    expect(terminalRightClickIntent('copy-paste', '')).toEqual({ kind: 'paste' });
    expect(terminalRightClickIntent('paste', 'leave selected')).toEqual({ kind: 'paste' });
  });

  it('snapshots the selection for the context menu', () => {
    expect(terminalRightClickIntent('menu', 'selected output')).toEqual({ kind: 'menu', selection: 'selected output' });
    expect(terminalRightClickIntent('menu', '')).toEqual({ kind: 'menu', selection: '' });
  });
});
