import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { gvkForResource, pluralLabel, type UsedByEntry } from '@kubus/shared';
import { useUsedBy } from '../../api/queries.js';
import { useDetailStore } from '../../state/detail.js';
import { statusTextColor } from '../../theme.js';
import { MiniFilterInput, matchesMiniFilter } from '../MiniFilterInput.js';
import { Section } from './Section.js';

export interface UsedByTarget {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: string;
  name: string;
  namespace?: string;
}

/** "3 Deployments · 1 CronJob · 8 Pods" — kinds in display order with counts. */
export function usedBySummary(items: UsedByEntry[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.ref.kind, (counts.get(item.ref.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, n]) => `${n} ${n === 1 ? kind : pluralLabel(kind)}`).join(' · ');
}

/**
 * The reverse-link section: every object that points at this one, one row
 * each, with how it does so. Workloads lead, standalone pods trail, and the
 * whole thing collapses to a one-line summary. Rows open the referrer in the
 * drawer with the usual back stack.
 */
export function UsedBySection({
  target,
  title = 'Used by',
  emptyText,
  /** Show only these kinds (e.g. a Service's "Routed by" wants Ingresses and routes). */
  kinds,
  defaultOpen = true,
}: {
  target: UsedByTarget;
  title?: string;
  emptyText?: string;
  kinds?: string[];
  defaultOpen?: boolean;
}) {
  const push = useDetailStore((s) => s.push);
  const query = useUsedBy(target);
  const [filter, setFilter] = useState('');
  const items = useMemo(() => {
    const all = query.data?.items ?? [];
    return kinds ? all.filter((item) => kinds.includes(item.ref.kind)) : all;
  }, [query.data, kinds]);
  const shown = useMemo(() => items.filter((item) => matchesMiniFilter(filter, [item.ref.kind, item.ref.name, item.ref.namespace ?? '', item.relation, item.detail ?? ''])), [items, filter]);
  const unavailable = (query.data?.unavailable ?? []).filter((kind) => !kinds || kinds.includes(kind));
  const truncated = query.data?.truncated ?? 0;
  const loading = !query.data && query.isLoading;
  const multiNamespace = items.some((item) => item.ref.namespace && item.ref.namespace !== target.namespace);

  const open = (item: UsedByEntry) =>
    push({
      ctx: item.ref.ctx,
      group: item.ref.group,
      version: item.ref.version,
      plural: item.ref.plural,
      kind: item.ref.kind,
      name: item.ref.name,
      namespace: item.ref.namespace,
      custom: !gvkForResource(item.ref.group, item.ref.version, item.ref.plural),
    });

  const description = loading ? undefined : items.length ? usedBySummary(items) : (emptyText ?? 'nothing references this object');
  return (
    <Section
      title={title}
      count={query.data ? items.length : undefined}
      description={description}
      defaultOpen={defaultOpen}
      flush
      actions={items.length > 6 ? <MiniFilterInput value={filter} onChange={setFilter} placeholder="Filter" /> : undefined}
    >
      {loading ? (
        <Box sx={{ p: 1.5 }}>
          <CircularProgress size={18} />
        </Box>
      ) : query.isError ? (
        <Typography variant="body2" sx={{ p: 1.5, color: statusTextColor('warning'), wordBreak: 'break-word' }}>
          Could not resolve references: {query.error instanceof Error ? query.error.message : String(query.error)}
        </Typography>
      ) : items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
          {emptyText ?? `Nothing references this ${target.kind}.`}
          {unavailable.length > 0 && ` ${unavailable.map(pluralLabel).join(', ')} could not be read.`}
        </Typography>
      ) : (
        <>
          <Table size="small" sx={{ '& th, & td': { px: 1 }, '& th:first-of-type, & td:first-of-type': { pl: 2 } }}>
            <TableHead>
              <TableRow>
                <TableCell>Kind</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>How</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((item) => (
                <TableRow key={`${item.ref.kind}/${item.ref.namespace ?? ''}/${item.ref.name}`} hover sx={{ cursor: 'pointer' }} onClick={() => open(item)}>
                  <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>{item.ref.kind}</TableCell>
                  <TableCell sx={{ wordBreak: 'break-word' }}>
                    <Link
                      component="button"
                      variant="body2"
                      underline="hover"
                      sx={{ textAlign: 'left', verticalAlign: 'baseline', fontWeight: 500 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        open(item);
                      }}
                    >
                      {item.ref.name}
                    </Link>
                    {multiNamespace && item.ref.namespace && item.ref.namespace !== target.namespace && (
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                        {item.ref.namespace}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ wordBreak: 'break-word' }}>
                    <Typography component="span" variant="body2">
                      {item.relation}
                    </Typography>
                    {item.detail && (
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75, fontFamily: 'monospace', fontSize: 11.5 }}>
                        {item.detail}
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {shown.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
              No matches.
            </Typography>
          )}
          {(truncated > 0 || unavailable.length > 0) && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, py: 1 }}>
              {truncated > 0 && `${truncated} more not shown. `}
              {unavailable.length > 0 && `${unavailable.map(pluralLabel).join(', ')} could not be read.`}
            </Typography>
          )}
        </>
      )}
    </Section>
  );
}
