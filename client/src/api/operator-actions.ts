import { useMutation } from '@tanstack/react-query';
import type { OperatorActionRequest } from '@kubus/shared';
import { apiFetch } from './http.js';
import { LOCAL_ERROR_HANDLING_META } from './mutation-errors.js';

/** Argo CD, Argo Rollouts, External Secrets and Flux actions (see the server's operator-actions). */
export function useOperatorAction() {
  return useMutation({
    meta: LOCAL_ERROR_HANDLING_META,
    mutationFn: ({ ctx, body }: { ctx: string; body: OperatorActionRequest }) =>
      apiFetch<{ ok: boolean }>(`/api/contexts/${encodeURIComponent(ctx)}/actions/operator`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  });
}
