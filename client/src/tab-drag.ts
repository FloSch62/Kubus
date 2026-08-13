export const TAB_TRANSFER_MIME = 'application/x-kubus-tab-transfer';

export function writeTabTransfer(data: DataTransfer, transferId: string): void {
  data.clearData();
  data.setData(TAB_TRANSFER_MIME, transferId);
  data.effectAllowed = 'move';
}

export function readTabTransfer(data: DataTransfer): string | undefined {
  const transferId = data.getData(TAB_TRANSFER_MIME);
  return transferId || undefined;
}

export function hasTabTransfer(data: DataTransfer): boolean {
  return [...data.types].includes(TAB_TRANSFER_MIME);
}

/** A rejected drop is a detach only when the pointer actually left this window. */
export function shouldDetachTabDrag(
  event: Pick<DragEvent, 'dataTransfer' | 'screenX' | 'screenY'>,
  bounds = { screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight },
): boolean {
  if (event.dataTransfer?.dropEffect === 'move') return false;
  return (
    event.screenX < bounds.screenX ||
    event.screenX >= bounds.screenX + bounds.outerWidth ||
    event.screenY < bounds.screenY ||
    event.screenY >= bounds.screenY + bounds.outerHeight
  );
}
