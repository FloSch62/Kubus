import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PluginInfo } from '@kubus/shared';
import { apiFetch } from '../api/http.js';

export function usePlugins() {
  return useQuery({ queryKey: ['plugins'], queryFn: () => apiFetch<PluginInfo[]>('/api/plugins'), staleTime: 1000, refetchInterval: 3000 });
}
export function usePluginMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled, path, remove }: { id?: string; enabled?: boolean; path?: string; remove?: boolean }) =>
      apiFetch<PluginInfo[]>(path ? '/api/plugins/install' : `/api/plugins/${encodeURIComponent(id!)}`, {
        method: path ? 'POST' : remove ? 'DELETE' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: remove ? undefined : JSON.stringify(path ? { path } : { enabled }),
      }),
    onSuccess: (data) => client.setQueryData(['plugins'], data),
  });
}
