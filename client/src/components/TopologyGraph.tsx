import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { topologyGraphsOptions, type TopologyFocus, type TopologyNamespaces } from '../api/queries.js';

export interface TopologyGraphProps {
  contexts: string[];
  /** One namespace list for every context, or one per context (each cluster keeps its own filter). */
  namespaces: TopologyNamespaces;
  focus?: TopologyFocus;
  hideDisconnected?: boolean;
  /** Fold idle old ReplicaSets into one placeholder per workload. Uncontrolled (on) when omitted. */
  foldReplicaSets?: boolean;
  onFoldReplicaSetsChange?: (fold: boolean) => void;
  /** Receives the visible counts; the graph then leaves them out of its own footer. */
  onStats?: (stats: TopologyStats) => void;
  /** Host for the export icon, e.g. beside the page's view switches.
   *  Omit to show an inline toolbar above the graph (resource Map tabs). */
  exportContainer?: HTMLElement | null;
  emptyTitle?: string;
}

export interface TopologyStats {
  resources: number;
  links: number;
  issues: number;
  /** Placeholders standing in for folded ReplicaSets. */
  folded: number;
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
  const [localExportContainer, setLocalExportContainer] = useState<HTMLDivElement | null>(null);

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
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {props.exportContainer === undefined && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', pb: 0.5 }}>
          <Box ref={setLocalExportContainer} sx={{ display: 'flex', alignItems: 'center' }} />
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Suspense fallback={graphLoading}>
          <TopologyGraphImpl {...props} exportContainer={props.exportContainer === undefined ? localExportContainer : props.exportContainer} />
        </Suspense>
      </Box>
    </Box>
  );
}
