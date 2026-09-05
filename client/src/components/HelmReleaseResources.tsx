import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useMemo, useState } from 'react';
import { gvkForResource, type HelmReleaseResource } from '@kubus/shared';
import { MiniFilterInput, matchesMiniFilter } from './MiniFilterInput.js';
import { useHelmReleaseResources } from '../api/queries.js';
import { useDetailStore } from '../state/detail.js';
import { AgeCell } from './AgeCell.js';
import { StatusChip } from './StatusChip.js';

export interface HelmResourceSummary {
  /** Manifest objects (hooks excluded: they are transient by design). */
  total: number;
  ready: number;
  progressing: number;
  failed: number;
  hooks: number;
}

export function helmResourceSummary(resources: HelmReleaseResource[] | undefined): HelmResourceSummary {
  const tracked = (resources ?? []).filter((resource) => !resource.hookEvents);
  return {
    total: tracked.length,
    ready: tracked.filter((resource) => resource.state === 'ready' || resource.state === 'present').length,
    progressing: tracked.filter((resource) => resource.state === 'progressing').length,
    failed: tracked.filter((resource) => resource.state === 'failed' || resource.state === 'missing').length,
    hooks: (resources?.length ?? 0) - tracked.length,
  };
}

/** One line for section descriptions and summary tiles: "12 of 14 ready, 1 failed". */
export function helmResourceSummaryText(summary: HelmResourceSummary): string {
  const parts = [`${summary.ready} of ${summary.total} ready`];
  if (summary.progressing) parts.push(`${summary.progressing} progressing`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  return parts.join(', ');
}

function resourceStatus(resource: HelmReleaseResource): { status: string; label: string } {
  switch (resource.state) {
    case 'ready':
      return { status: 'ready', label: 'Ready' };
    case 'present':
      return { status: 'ready', label: 'Present' };
    case 'progressing':
      return { status: 'progressing', label: 'Progressing' };
    case 'failed':
      return { status: 'failed', label: 'Failed' };
    case 'missing':
      return resource.hookEvents ? { status: 'not present', label: 'Not present' } : { status: 'unavailable', label: 'Missing' };
    default:
      return { status: 'unknown', label: 'Unknown' };
  }
}

const EMPTY_RESOURCES: HelmReleaseResource[] = [];

function openable(resource: HelmReleaseResource): boolean {
  return !!resource.plural && resource.state !== 'missing' && resource.state !== 'unknown';
}

/**
 * The release manifest resolved against the cluster: every object with its
 * live state, workloads with readiness. Rows open the resource's detail
 * drawer, so a failing Deployment is one click from its pods and events.
 */
export function HelmReleaseResources({ ctx, ns, name, active }: { ctx: string; ns: string; name: string; active: boolean }) {
  const query = useHelmReleaseResources(ctx, ns, name, { active });
  const push = useDetailStore((s) => s.push);
  const resources = query.data ?? EMPTY_RESOURCES;
  const summary = helmResourceSummary(query.data);
  const [filter, setFilter] = useState('');
  const shown = useMemo(
    () => resources.filter((r) => matchesMiniFilter(filter, [r.kind, r.name, r.namespace ?? '', r.state, resourceStatus(r).label])),
    [resources, filter],
  );

  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, px: 2, py: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {query.data ? `${helmResourceSummaryText(summary)}${summary.hooks ? `, ${summary.hooks} hook${summary.hooks === 1 ? '' : 's'}` : ''}` : 'Resolving the manifest against the cluster…'}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {resources.length > 3 && <MiniFilterInput value={filter} onChange={setFilter} placeholder="Filter resources" width={200} />}
        {query.dataUpdatedAt ? (
          <Typography variant="caption" color="text.secondary">
            checked <AgeCell timestamp={new Date(query.dataUpdatedAt).toISOString()} variant="caption" /> ago
          </Typography>
        ) : null}
        <Tooltip title="Re-check the release resources">
          <span>
            <IconButton size="small" aria-label="Refresh release resources" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {query.isFetching ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {query.error ? (
        <Alert severity="error" sx={{ mx: 2, mb: 1 }}>
          {query.error.message}
        </Alert>
      ) : null}
      {query.data && resources.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>
          This revision renders no Kubernetes objects.
        </Typography>
      ) : null}
      {resources.length > 0 && shown.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>
          No resources match the filter.
        </Typography>
      ) : null}
      {shown.length > 0 ? (
        <Table size="small" sx={{ '& th, & td': { px: 1 }, '& th:first-of-type, & td:first-of-type': { pl: 2 } }}>
          <TableHead>
            <TableRow>
              <TableCell>Kind</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Namespace</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Age</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((resource) => {
              const status = resourceStatus(resource);
              const clickable = openable(resource);
              return (
                <TableRow
                  key={`${resource.apiVersion}/${resource.kind}/${resource.namespace ?? ''}/${resource.name}/${resource.hookEvents ? 'hook' : 'manifest'}`}
                  hover={clickable}
                  sx={{ cursor: clickable ? 'pointer' : 'default', opacity: resource.state === 'missing' && resource.hookEvents ? 0.7 : 1 }}
                  onClick={() => {
                    if (!clickable) return;
                    push({
                      ctx,
                      group: resource.group,
                      version: resource.version,
                      plural: resource.plural,
                      kind: resource.kind,
                      name: resource.name,
                      namespace: resource.namespace,
                      custom: !gvkForResource(resource.group, resource.version, resource.plural),
                    });
                  }}
                >
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {resource.kind}
                    {resource.hookEvents ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        hook · {resource.hookEvents.join(', ') || 'no events'}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell sx={{ wordBreak: 'break-word' }} title={resource.name}>
                    {resource.name}
                  </TableCell>
                  <TableCell>{resource.namespace ?? <Typography variant="caption" color="text.secondary">cluster</Typography>}</TableCell>
                  <TableCell>
                    <Tooltip title={resource.message ?? ''} placement="top-start">
                      <span>
                        <StatusChip status={status.status} label={status.label} />
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{resource.createdAt ? <AgeCell timestamp={resource.createdAt} /> : ''}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </Box>
  );
}
