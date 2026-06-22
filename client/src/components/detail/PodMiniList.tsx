import { Box, CircularProgress, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { KubeObject } from '@kubus/shared';
import { StatusChip } from '../StatusChip.js';
import { podSummary } from '../../kube-display.js';
import { useDetailStore } from '../../state/detail.js';

/** Compact clickable pod table used by Node and Service detail views. */
export function PodMiniList({ ctx, pods, title, loading, emptyText }: { ctx: string; pods: KubeObject[]; title: string; loading?: boolean; emptyText?: string }) {
  const push = useDetailStore((s) => s.push);
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {title}
        {!loading && ` (${pods.length})`}
      </Typography>
      {loading ? (
        <CircularProgress size={18} />
      ) : pods.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {emptyText ?? 'No pods.'}
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Namespace</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Ready</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Restarts</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {pods.map((pod) => {
              const summary = podSummary(pod);
              return (
                <TableRow
                  key={pod.metadata.uid}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => push({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: pod.metadata.name, namespace: pod.metadata.namespace })}
                >
                  <TableCell>{pod.metadata.namespace}</TableCell>
                  <TableCell sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={pod.metadata.name}>
                    {pod.metadata.name}
                  </TableCell>
                  <TableCell>{summary.ready}</TableCell>
                  <TableCell>
                    <StatusChip status={summary.status} />
                  </TableCell>
                  <TableCell>{summary.restarts}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}
