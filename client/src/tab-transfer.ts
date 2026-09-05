import { useDockStore, type DockTab } from './state/dock.js';
import { useTabsStore, type PageTab } from './state/tabs.js';
import { terminalHandle } from './terminal-registry.js';

const CHANNEL_NAME = 'kubus-tab-transfer-v1';
const CLAIM_TIMEOUT_MS = 10_000;
const SOURCE_TTL_MS = 2 * 60_000;

export type TransferableTab =
  | { surface: 'page'; tab: PageTab }
  | { surface: 'dock'; tab: DockTab };

type TransferMessage =
  | { kind: 'claim'; requestId: string; transferId: string }
  | { kind: 'offer'; requestId: string; transferId: string; offered?: TransferableTab }
  | { kind: 'cancel'; transferId: string }
  | { kind: 'complete'; transferId: string };

interface TransferSource {
  prepare: () => Promise<boolean>;
  snapshot: () => TransferableTab | undefined;
  cancel: () => void;
  complete: () => void;
  prepared?: Promise<TransferableTab | undefined>;
  expires: ReturnType<typeof setTimeout>;
}

let channel: BroadcastChannel | undefined;
const sources = new Map<string, TransferSource>();
const claims = new Map<
  string,
  {
    resolve: (tab: TransferableTab | undefined) => void;
    retry: ReturnType<typeof setInterval>;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createTabTransferId(): string {
  return `transfer-${randomId()}`;
}

function transferChannel(): BroadcastChannel | undefined {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return undefined;
  }
  channel.addEventListener('message', (event: MessageEvent<TransferMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'claim') {
      const source = sources.get(message.transferId);
      if (!source) return;
      source.prepared ??= (async () => {
        try {
          return (await source.prepare()) ? source.snapshot() : undefined;
        } catch {
          return undefined;
        }
      })();
      void source.prepared.then((offered) => {
        channel?.postMessage({ ...message, kind: 'offer', offered } satisfies TransferMessage);
      });
      return;
    }
    if (message.kind === 'offer') {
      const claim = claims.get(message.requestId);
      if (!claim) return;
      clearInterval(claim.retry);
      clearTimeout(claim.timer);
      claims.delete(message.requestId);
      claim.resolve(message.offered);
      return;
    }
    if (message.kind === 'cancel') {
      const source = sources.get(message.transferId);
      if (source) {
        source.cancel();
        source.prepared = undefined;
      }
      return;
    }
    const source = sources.get(message.transferId);
    if (!source) return;
    clearTimeout(source.expires);
    sources.delete(message.transferId);
    source.complete();
  });
  return channel;
}

function registerSource(transferId: string, options: Omit<TransferSource, 'expires' | 'prepared'>): void {
  const expires = setTimeout(() => {
    const source = sources.get(transferId);
    source?.cancel();
    sources.delete(transferId);
  }, SOURCE_TTL_MS);
  sources.set(transferId, { ...options, expires });
  transferChannel();
}

/** Register a store tab as the source of an opaque cross-window handoff. */
export function registerTabTransferSource(transferId: string, surface: TransferableTab['surface'], tabId: string): void {
  if (surface === 'page') {
    registerSource(transferId, {
      prepare: async () => true,
      snapshot: () => {
        const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
        return tab ? { surface: 'page', tab } : undefined;
      },
      cancel: () => undefined,
      complete: () => useTabsStore.getState().closeTab(tabId),
    });
    return;
  }

  registerSource(transferId, {
    prepare: async () => {
      const tab = useDockStore.getState().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return false;
      if (tab.kind === 'logs' || !tab.terminalId) return true;
      return terminalHandle(tabId)?.prepareTransfer() ?? false;
    },
    snapshot: () => {
      const tab = useDockStore.getState().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return undefined;
      if (tab.kind === 'terminal' || tab.kind === 'node-shell') {
        return {
          surface: 'dock',
          tab: { ...tab, snapshot: terminalHandle(tabId)?.snapshot() },
        };
      }
      return { surface: 'dock', tab };
    },
    cancel: () => terminalHandle(tabId)?.cancelTransfer(),
    complete: () => useDockStore.getState().closeTab(tabId),
  });
}

/** Retire a token after a reorder/drop handled entirely in this renderer. */
export function finishLocalTabTransfer(transferId: string): void {
  const source = sources.get(transferId);
  if (!source) return;
  clearTimeout(source.expires);
  sources.delete(transferId);
  source.cancel();
}

export function claimTabTransfer(transferId: string): Promise<TransferableTab | undefined> {
  const bus = transferChannel();
  if (!bus) return Promise.resolve(undefined);
  const requestId = randomId();
  return new Promise((resolve) => {
    const request = () => bus.postMessage({ kind: 'claim', requestId, transferId } satisfies TransferMessage);
    const retry = setInterval(request, 250);
    const timer = setTimeout(() => {
      clearInterval(retry);
      claims.delete(requestId);
      bus.postMessage({ kind: 'cancel', transferId } satisfies TransferMessage);
      resolve(undefined);
    }, CLAIM_TIMEOUT_MS);
    claims.set(requestId, { resolve, retry, timer });
    request();
  });
}

export function completeTabTransfer(transferId: string): void {
  transferChannel()?.postMessage({ kind: 'complete', transferId } satisfies TransferMessage);
}

export function cancelTabTransfer(transferId: string): void {
  transferChannel()?.postMessage({ kind: 'cancel', transferId } satisfies TransferMessage);
}

/** Claim and insert a tab. Live terminals complete only after server-side attach. */
export async function receiveTabTransfer(
  transferId: string,
  targetId?: string,
  edge: 'before' | 'after' = 'after',
  replacePlaceholder = false,
): Promise<boolean> {
  const offered = await claimTabTransfer(transferId);
  if (!offered) return false;

  if (offered.surface === 'page') {
    if (replacePlaceholder) useTabsStore.setState({ tabs: [], activeId: undefined });
    const adopted = useTabsStore.getState().adoptTab(offered.tab, targetId, edge);
    if (adopted) completeTabTransfer(transferId);
    else transferChannel()?.postMessage({ kind: 'cancel', transferId } satisfies TransferMessage);
    return adopted;
  }

  const live =
    (offered.tab.kind === 'terminal' || offered.tab.kind === 'node-shell') &&
    !!offered.tab.terminalId;
  const incoming = live ? { ...offered.tab, transferId } : offered.tab;
  const adopted = useDockStore.getState().adoptTab(incoming, targetId, edge);
  if (!adopted) {
    transferChannel()?.postMessage({ kind: 'cancel', transferId } satisfies TransferMessage);
    return false;
  }
  if (!live) completeTabTransfer(transferId);
  return true;
}
