export function formatCpu(milli: number): string {
  return milli >= 1000 ? `${(milli / 1000).toFixed(2)} cores` : `${milli}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)}Gi`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(0)}Mi`;
  if (bytes >= 2 ** 10) return `${(bytes / 2 ** 10).toFixed(0)}Ki`;
  return `${bytes}B`;
}

export function formatBps(bytesPerSec: number): string {
  if (bytesPerSec > 0 && bytesPerSec < 1) return '<1B/s';
  return `${formatBytes(Math.round(bytesPerSec))}/s`;
}

/** "3 items" / "1 item" — count with a naively pluralized noun. */
export function countLabel(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
