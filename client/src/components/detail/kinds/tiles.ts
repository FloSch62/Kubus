import type { DetailCondition } from '../nested-conditions.js';
import type { SummaryItem } from '../SummaryStrip.js';

/** A summary tile for one condition: Yes / No / Unknown, toned, with the reason on hover. */
export function conditionTile(label: string, condition: DetailCondition | undefined, hint?: string): SummaryItem {
  const status = condition?.status;
  return {
    label,
    value: status === 'True' ? 'Yes' : status === 'False' ? 'No' : (status ?? '—'),
    tone: status === 'True' ? 'success' : status === 'False' ? 'error' : undefined,
    title: condition?.reason,
    hint,
  };
}
