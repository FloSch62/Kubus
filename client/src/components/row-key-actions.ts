import { gvkForResource } from '@kubus/shared';
import type { RowKeyAction } from '../row-keys.js';
import { execTargetContainer } from '../kube-display.js';
import { isForwardableKind } from './PortForwardDialog.js';
import { isLogTargetKind, type RowActionTarget } from './RowActions.js';

const SCALABLE = new Set(['Deployment', 'StatefulSet', 'ReplicaSet']);
const RESTARTABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']);

/**
 * Row keys that have an action for this row, mirroring the row menu: a key
 * only fires where the menu offers the same action. Custom kinds that reuse a
 * builtin kind name get the generic actions only, like the menu.
 */
export function rowKeyActionsFor(target: RowActionTarget): Set<RowKeyAction> {
  const actionKind = gvkForResource(target.group, target.version, target.plural)?.kind === target.kind ? target.kind : undefined;
  const actions = new Set<RowKeyAction>(['manifest', 'delete']);
  if (!actionKind) return actions;
  if (isLogTargetKind(actionKind)) actions.add('logs');
  if ((actionKind === 'Pod' && execTargetContainer(target.obj)) || actionKind === 'Node') actions.add('shell');
  if (isForwardableKind(actionKind)) actions.add('forward');
  if (SCALABLE.has(actionKind)) actions.add('scale');
  if (RESTARTABLE.has(actionKind)) actions.add('restart');
  return actions;
}
