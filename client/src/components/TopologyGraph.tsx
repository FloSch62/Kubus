import { Suspense, lazy, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { topologyGraphsOptions, type TopologyFocus } from '../api/queries.js';

export interface TopologyGraphProps {
  contexts: string[];
  namespaces: string[];
  focus?: TopologyFocus;
  hideDisconnected?: boolean;
  emptyTitle?: string;
}

const loadImpl = () => import('./TopologyGraphImpl.js');
const TopologyGraphImpl = lazy(loadImpl);

const graphLoading = (
  <Box sx={{ height: '100%', minHeight: 360, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default', display: 'grid', placeItems: 'center' }}>
    <Stack spacing={1} sx={{ alignItems: 'center' }}>
      <CircularProgress size={24} />
      <Typography variant="body2" color="text.secondary">
        Loading topology…
      </Typography>
    </Stack>
  </Box>
);

export function TopologyGraph(props: TopologyGraphProps) {
  const { contexts, namespaces, focus } = props;
  const queryClient = useQueryClient();

  // Kick off the graph fetch from the wrapper so it runs in parallel with the
  // lazy chunk download instead of waiting for the impl to mount. One-shot:
  // once the impl is up, its own useQuery keeps the data fresh.
  const prefetched = useRef(false);
  useEffect(() => {
    if (prefetched.current || contexts.length === 0) return;
    prefetched.current = true;
    void queryClient.prefetchQuery(topologyGraphsOptions(contexts, namespaces, focus));
  }, [queryClient, contexts, namespaces, focus]);

  return (
    <Suspense fallback={graphLoading}>
      <TopologyGraphImpl {...props} />
    </Suspense>
  );
}
