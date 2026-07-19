import type { MutationMeta } from '@tanstack/react-query';

const LOCAL_ERROR_KEY = 'errorHandledLocally';

/** Attach to mutations whose caller or rendered state already surfaces failures. */
export const LOCAL_ERROR_HANDLING_META = { [LOCAL_ERROR_KEY]: true } as const satisfies MutationMeta;

export function isMutationErrorHandledLocally(meta: MutationMeta | undefined): boolean {
  return meta?.[LOCAL_ERROR_KEY] === true;
}
