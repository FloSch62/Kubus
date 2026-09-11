
const GOOD = new Set(['running', 'succeeded', 'active', 'bound', 'ready', 'available', 'complete', 'completed', 'deployed', 'true', 'healthy', 'synced', 'up', 'attached']);
const BAD = new Set([
  'failed',
  'crashloopbackoff',
  'imagepullbackoff',
  'errimagepull',
  'error',
  'evicted',
  'lost',
  'notready',
  'oomkilled',
  'false',
  'unhealthy',
  'degraded',
  'stopped',
  'down',
  'notestablished',
  'nameconflict',
  'stalled',
  'replicafailure',
  'unavailable',
  'noendpoints',
]);
const WARN = new Set([
  'pending',
  'terminating',
  'containercreating',
  'podinitializing',
  'released',
  'unknown',
  'warning',
  'schedulingdisabled',
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
  'superseded',
  'uninstalling',
  'progressing',
  'paused',
  'terminated',
]);

export function statusColor(status: string): 'success' | 'error' | 'warning' | 'default' {
  const normalized = status.trim().toLowerCase();
  if (GOOD.has(normalized)) return 'success';
  if (BAD.has(normalized)) return 'error';
  if (WARN.has(normalized)) return 'warning';
  return 'default';
}

/** `size="md"` is the detail-header variant: the status word sits next to a
 *  resource name, so it steps up with it. */
export function StatusChip({ status, label, size = 'sm' }: { status: string; label?: string; size?: 'sm' | 'md' }) {
  if (!status) return null;
  const color = statusColor(status);
  const md = size === 'md';
  return (
    <span className={`kubus-status kubus-status-${color}${md ? ' kubus-status-md' : ''}`}>
      <span className="kubus-status-dot" aria-hidden="true" />
      {label ?? status}
    </span>
  );
}
