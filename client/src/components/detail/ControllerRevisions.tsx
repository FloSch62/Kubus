import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { useMemo } from 'react';
import { DETAIL_LIST_LIVE_MS, useResourceList } from '../../api/queries.js';
import { podSummary } from '../../kube-display.js';
import { useDetailStore } from '../../state/detail.js';
import { statusTextColor } from '../../theme.js';
import { AgeCell } from '../AgeCell.js';
import { CountPill, Section } from './Section.js';
import { controlledBy } from './WorkloadParts.js';

/**
 * A StatefulSet's or DaemonSet's revisions that hold pods right now, the
 * ControllerRevision counterpart of a Deployment's "Replica sets" section.
 * A partitioned or half-done rollout shows as two rows with their pods and
 * images; revisions without pods are left to the History tab.
 */

type RevisionShape = KubeObject & { revision?: number; data?: { spec?: { template?: { spec?: { containers?: Array<{ image?: string }>; initContainers?: Array<{ image?: string }> } } } } };

export interface RevisionRow {
  revision: number;
  name: string;
  createdAt?: string;
  images: string[];
  pods: number;
  ready: number;
  current: boolean;
}

/**
 * Which revision a pod runs. StatefulSet pods carry the revision's full name
 * in `controller-revision-hash`; DaemonSet pods only its hash suffix.
 */
export function podRevisionName(pod: KubeObject, setName: string, revisionNames: ReadonlySet<string>): string | undefined {
  const hash = pod.metadata.labels?.['controller-revision-hash'];
  if (!hash) return undefined;
  if (revisionNames.has(hash)) return hash;
  const prefixed = `${setName}-${hash}`;
  return revisionNames.has(prefixed) ? prefixed : undefined;
}

/**
 * Rows for the revisions that hold pods, plus the one the controller is
 * rolling towards (`updateRevision`, else the newest), newest first.
 */
export function revisionRows(revisions: KubeObject[], pods: KubeObject[], setName: string, updateRevision?: string): { rows: RevisionRow[]; hidden: number } {
  const sorted = [...(revisions as RevisionShape[])].sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
  const names = new Set(sorted.map((r) => r.metadata.name));
  const current = updateRevision && names.has(updateRevision) ? updateRevision : sorted[0]?.metadata.name;
  const counts = new Map<string, { pods: number; ready: number }>();
  for (const pod of pods) {
    const name = podRevisionName(pod, setName, names);
    if (!name) continue;
    const entry = counts.get(name) ?? { pods: 0, ready: 0 };
    entry.pods += 1;
    const [ready, total] = podSummary(pod).ready.split('/');
    if (ready === total && total !== '0') entry.ready += 1;
    counts.set(name, entry);
  }
  const rows = sorted
    .filter((r) => r.metadata.name === current || counts.has(r.metadata.name))
    .map((r) => {
      const template = r.data?.spec?.template?.spec;
      return {
        revision: r.revision ?? 0,
        name: r.metadata.name,
        createdAt: r.metadata.creationTimestamp,
        images: [...(template?.initContainers ?? []), ...(template?.containers ?? [])].map((c) => c.image ?? '').filter(Boolean),
        pods: counts.get(r.metadata.name)?.pods ?? 0,
        ready: counts.get(r.metadata.name)?.ready ?? 0,
        current: r.metadata.name === current,
      };
    });
  return { rows, hidden: sorted.length - rows.length };
}

export function ControllerRevisions({
  ctx,
  obj,
  pods,
  labelSelector,
  updateRevision,
}: {
  ctx: string;
  obj: KubeObject;
  pods: KubeObject[];
  labelSelector: string | undefined;
  /** StatefulSets name their target revision; DaemonSets roll towards the newest. */
  updateRevision?: string;
}) {
  const push = useDetailStore((s) => s.push);
  const namespace = obj.metadata.namespace;
  const query = useResourceList(
    namespace && labelSelector ? { ctx, group: 'apps', version: 'v1', plural: 'controllerrevisions', namespace, labelSelector } : undefined,
    { liveMs: DETAIL_LIST_LIVE_MS },
  );
  const { rows, hidden } = useMemo(() => {
    const owned = (query.data?.items ?? []).filter((r) => controlledBy(r, new Set([obj.metadata.uid])));
    return revisionRows(owned, pods, obj.metadata.name, updateRevision);
  }, [query.data?.items, obj.metadata.uid, obj.metadata.name, pods, updateRevision]);
  if (!rows.length) return null;
  const currentRow = rows.find((r) => r.current);
  const open = (name: string) => push({ ctx, group: 'apps', version: 'v1', plural: 'controllerrevisions', kind: 'ControllerRevision', name, namespace });
  return (
    <Section
      title="Revisions"
      count={rows.length}
      flush
      defaultOpen={rows.length > 1}
      description={hidden > 0 ? `${hidden} older without pods, see History` : currentRow ? `revision ${currentRow.revision}` : undefined}
    >
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Revision</TableCell>
            <TableCell>Name and images</TableCell>
            <TableCell>Ready</TableCell>
            <TableCell>Age</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.name} hover sx={{ cursor: 'pointer' }} onClick={() => open(r.name)}>
              <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75 }}>
                  {r.revision || '—'}
                  {r.current && <CountPill value="current" sx={{ color: 'primary.main', bgcolor: (t) => `${t.palette.primary.main}1a` }} />}
                </Stack>
              </TableCell>
              <TableCell sx={{ wordBreak: 'break-word', verticalAlign: 'top' }}>
                <Link
                  component="button"
                  variant="body2"
                  underline="hover"
                  sx={{ textAlign: 'left', verticalAlign: 'baseline' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    open(r.name);
                  }}
                >
                  {r.name}
                </Link>
                {r.images.map((image) => (
                  <Typography key={image} variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'monospace', fontSize: 11.5, wordBreak: 'break-all' }}>
                    {image}
                  </Typography>
                ))}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                <Box component="span" sx={{ color: r.ready < r.pods ? statusTextColor('warning') : 'inherit' }}>
                  {r.ready}/{r.pods}
                </Box>
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                <AgeCell timestamp={r.createdAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}
