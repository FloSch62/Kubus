const READY_RE = /^(\d+)\/(\d+)$/;

function isNotReady(value: string): boolean {
  const match = READY_RE.exec(value.trim());
  if (!match) return false;
  return Number(match[1]) < Number(match[2]);
}

/** `muted` suppresses the not-ready highlight, e.g. for Succeeded pods
 *  where 0/1 is the expected terminal state, not a problem. */
export function ReadyCounter({ value, muted = false }: { value: string; muted?: boolean }) {
  return (
    <span className={!muted && isNotReady(value) ? 'kubus-ready-warning' : undefined}>
      {value}
    </span>
  );
}
