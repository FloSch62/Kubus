import { describe, expect, it, vi } from 'vitest';
import { selectedTerminalText } from '../../../client/src/terminal-selection';

describe('selectedTerminalText', () => {
  it('returns selected terminal text only when copy on select is enabled', () => {
    const terminal = {
      hasSelection: vi.fn(() => true),
      getSelection: vi.fn(() => 'selected output'),
    };

    expect(selectedTerminalText(terminal, false)).toBeNull();
    expect(terminal.hasSelection).not.toHaveBeenCalled();

    expect(selectedTerminalText(terminal, true)).toBe('selected output');
    expect(terminal.hasSelection).toHaveBeenCalledOnce();
    expect(terminal.getSelection).toHaveBeenCalledOnce();
  });

  it('ignores an empty terminal selection', () => {
    const terminal = {
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ''),
    };

    expect(selectedTerminalText(terminal, true)).toBeNull();
    expect(terminal.getSelection).not.toHaveBeenCalled();
  });
});
