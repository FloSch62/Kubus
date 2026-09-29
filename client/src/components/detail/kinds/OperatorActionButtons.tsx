import { useState, type ReactNode } from 'react';
import type { OperatorAction, OperatorActionRequest } from '@kubus/shared';
import { useOperatorAction } from '../../../api/operator-actions.js';
import { useIsProtected } from '../../../state/clusters.js';
import { showErrorToast, showToast } from '../../../state/toast.js';
import { ConfirmDialog } from '../../ConfirmDialog.js';
import { QuickActionButton } from '../../RowActions.js';
import type { CustomKindActionProps } from './registry.js';

export interface OperatorActionSpec {
  action: OperatorAction;
  label: string;
  icon: ReactNode;
  emphasis?: boolean;
  /** Toast shown once the patch landed. */
  done: string;
  /** Extra request fields (Sync's prune flag). */
  body?: Partial<OperatorActionRequest>;
  /**
   * Actions that change what runs ask first, and on a protected cluster
   * want the object's name typed; re-reads (refresh, reconcile) run at once.
   */
  confirm?: { title: string; message: ReactNode; confirmLabel: string; danger?: boolean };
  /** Called as the confirmation opens, to reset options the dialog offers. */
  onOpen?: () => void;
}

/**
 * Labeled buttons for a custom resource's operator actions, for the drawer's
 * quick-action bar. Confirmation, the protected-cluster guard and error
 * toasts work the way they do for the built-in workload actions.
 */
export function OperatorActionButtons({ target, actions }: { target: CustomKindActionProps; actions: OperatorActionSpec[] }) {
  const mutation = useOperatorAction();
  const isProtected = useIsProtected(target.ctx);
  const [pending, setPending] = useState<OperatorActionSpec | null>(null);
  const name = target.obj.metadata.name;
  const run = (spec: OperatorActionSpec, after?: () => void) =>
    mutation.mutate(
      {
        ctx: target.ctx,
        body: { action: spec.action, group: target.group, version: target.version, plural: target.plural, namespace: target.obj.metadata.namespace ?? '', name, ...spec.body },
      },
      {
        onSuccess: () => {
          after?.();
          showToast('success', spec.done);
        },
        onError: (err) => {
          after?.();
          showErrorToast(err);
        },
      },
    );
  // The dialog shows the spec as it is now (Sync's prune checkbox lives in
  // the caller's state), so look the open one up again by action.
  const current = pending ? (actions.find((a) => a.action === pending.action) ?? pending) : null;
  return (
    <>
      {actions.map((spec) => (
        <QuickActionButton
          key={spec.action}
          icon={spec.icon}
          label={spec.label}
          emphasis={spec.emphasis}
          disabled={mutation.isPending}
          onClick={() => {
            if (!spec.confirm) {
              run(spec);
              return;
            }
            spec.onOpen?.();
            setPending(spec);
          }}
        />
      ))}
      <ConfirmDialog
        open={!!current?.confirm}
        title={current?.confirm?.title ?? ''}
        message={current?.confirm?.message ?? ''}
        confirmLabel={current?.confirm?.confirmLabel}
        danger={current?.confirm?.danger}
        busy={mutation.isPending}
        confirmText={isProtected ? name : undefined}
        onClose={() => setPending(null)}
        onConfirm={() => current && run(current, () => setPending(null))}
      />
    </>
  );
}
