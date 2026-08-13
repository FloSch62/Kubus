export interface TerminalHandle {
  /** Ask the server to freeze output at an ordered transfer boundary. */
  prepareTransfer: () => Promise<boolean>;
  /** Resume the source session if the destination never claims it. */
  cancelTransfer: () => void;
  /** ANSI serialization of the visible terminal and scrollback. */
  snapshot: () => string;
}

const terminals = new Map<string, TerminalHandle>();

export function registerTerminal(tabId: string, handle: TerminalHandle): () => void {
  terminals.set(tabId, handle);
  return () => {
    if (terminals.get(tabId) === handle) terminals.delete(tabId);
  };
}

export function terminalHandle(tabId: string | null | undefined): TerminalHandle | undefined {
  return tabId ? terminals.get(tabId) : undefined;
}
