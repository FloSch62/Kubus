interface TerminalSelection {
  hasSelection: () => boolean;
  getSelection: () => string;
}

/** Return the terminal selection when automatic clipboard copying is enabled. */
export function selectedTerminalText(terminal: TerminalSelection, copyOnSelect: boolean): string | null {
  if (!copyOnSelect || !terminal.hasSelection()) return null;
  return terminal.getSelection();
}
