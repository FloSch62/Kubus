import type { ReactNode } from 'react';

interface QueryHarness {
  queryConfigs: unknown[];
  mutationConfigs: unknown[];
  multiQueryConfigs: unknown[];
  queryResults: Map<string, { data?: unknown; isLoading?: boolean; error?: unknown }>;
  queryClient: unknown;
}

function harness(): QueryHarness {
  const value = Reflect.get(globalThis, Symbol.for('kubus.test.query-harness')) as QueryHarness | undefined;
  if (!value) throw new Error('query test harness is not initialized');
  return value;
}

export const keepPreviousData = Symbol('keep-previous-data');

export function queryOptions<T>(config: T): T {
  return config;
}

export function useQueryClient(): QueryHarness['queryClient'] {
  return harness().queryClient;
}

export function useQuery(config: { queryKey?: readonly unknown[] }) {
  const state = harness();
  state.queryConfigs.push(config);
  const result = state.queryResults.get(JSON.stringify(config.queryKey));
  return { ...config, data: result?.data, isLoading: result?.isLoading ?? false, error: result?.error ?? null };
}

export function useMutation<T>(config: T): T {
  harness().mutationConfigs.push(config);
  return config;
}

export function useQueries(config: { queries: unknown[]; combine: (results: Array<{ data?: unknown }>) => unknown }) {
  harness().multiQueryConfigs.push(config);
  return config.combine(config.queries.map(() => ({ data: { available: true, items: [] } })));
}

// These exports keep component imports harmless when a test reaches the app
// bootstrap while the lightweight hook adapter is active.
export class QueryClient {}
export class MutationCache {}
export function QueryClientProvider({ children }: { children: ReactNode }) {
  return children;
}
