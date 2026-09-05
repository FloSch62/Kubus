import type { AppWindowDockTab } from '@kubus/shared';
import { useDockStore, type DockTab } from './state/dock.js';
import { useTabsStore } from './state/tabs.js';
import { createTabTransferId, finishLocalTabTransfer, registerTabTransferSource } from './tab-transfer.js';
import { detachTabWindow, openAppWindow } from './window-management.js';
import { currentAppWindowContext } from './window-context.js';

export type TabSurface = 'page' | 'dock';

function dockLaunchTab(tab: DockTab): AppWindowDockTab {
  const { id: _id, ...copy } = tab;
  if (copy.kind === 'terminal' || copy.kind === 'node-shell') {
    const { terminalId: _terminalId, transferId: _transferId, snapshot: _snapshot, ...launch } = copy;
    return launch;
  }
  return copy;
}

/** Open the same content as an independent tab/session in another window. */
export function openTabInNewWindow(surface: TabSurface, tabId: string, title: string): boolean {
  if (surface === 'page') {
    const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    const { id: _id, ...copy } = tab;
    return openAppWindow({ kind: 'page', title, context: currentAppWindowContext(), tab: copy });
  }
  const tab = useDockStore.getState().tabs.find((candidate) => candidate.id === tabId);
  return tab ? openAppWindow({ kind: 'dock', title, context: currentAppWindowContext(), tab: dockLaunchTab(tab) }) : false;
}

/** Move the existing identity; live terminal sessions are reattached, not redialed. */
export function moveTabToNewWindow(surface: TabSurface, tabId: string, title: string): boolean {
  const transferId = createTabTransferId();
  registerTabTransferSource(transferId, surface, tabId);
  const opened = openAppWindow({ kind: 'tab-transfer', surface, transferId, title, context: currentAppWindowContext() });
  if (!opened) finishLocalTabTransfer(transferId);
  return opened;
}

export function detachDraggedTab(surface: TabSurface, tabId: string, title: string): string {
  const transferId = createTabTransferId();
  registerTabTransferSource(transferId, surface, tabId);
  void detachTabWindow({ kind: 'tab-transfer', surface, transferId, title, context: currentAppWindowContext() });
  return transferId;
}
