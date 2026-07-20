import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import type { KubeObject } from '@kubus/shared';
import { AgeCell, formatAge } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';
import { Section } from './Section.js';

export function KeyValueChips({ title, entries }: { title: string; entries: Record<string, string> | undefined }) {
  const items = Object.entries(entries ?? {});
  if (!items.length) return null;
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <ChipList items={items} />
    </Box>
  );
}

/** Collapsible chip-list section for labels/annotations-style maps. */
export function KeyValueSection({ title, entries, defaultOpen = true }: { title: string; entries: Record<string, string> | undefined; defaultOpen?: boolean }) {
  const items = Object.entries(entries ?? {});
  if (!items.length) return null;
  return (
    <Section title={title} count={items.length} defaultOpen={defaultOpen}>
      <ChipList items={items} />
    </Section>
  );
}

/** Href for values that are plain web links; anything else (other schemes, garbage) stays inert. */
function safeHref(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function ChipList({ items }: { items: Array<[string, string]> }) {
  return (
    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
      {items.map(([k, v]) => {
        const href = safeHref(v);
        return href ? (
          <Chip
            key={k}
            component="a"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            clickable
            icon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
            label={`${k}=${v}`}
            variant="outlined"
            sx={{ maxWidth: 420 }}
            title={`Open ${v}`}
          />
        ) : (
          <Chip key={k} label={`${k}=${v}`} variant="outlined" sx={{ maxWidth: 420 }} title={`${k}=${v}`} />
        );
      })}
    </Stack>
  );
}

type Condition = { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string };

function objConditions(obj: KubeObject): Condition[] {
  return (obj.status as { conditions?: Condition[] } | undefined)?.conditions ?? [];
}

/** Whether any condition deviates from its healthy status. */
export function hasUnhealthyCondition(obj: KubeObject, goodWhen?: (type: string) => 'True' | 'False'): boolean {
  return objConditions(obj).some((c) => c.status !== (goodWhen?.(c.type) ?? 'True'));
}

/**
 * Compact one-chip-per-condition row; reason/message/age live in the
 * tooltip. Healthy conditions are subtle, unhealthy ones pop.
 */
export function ConditionChips({ obj, goodWhen }: { obj: KubeObject; goodWhen?: (type: string) => 'True' | 'False' }) {
  const conditions = objConditions(obj);
  if (!conditions.length) return null;
  return (
    <>
      {conditions.map((c) => {
        const expected = goodWhen?.(c.type) ?? 'True';
        const healthy = c.status === expected;
        const unknown = c.status === 'Unknown';
        const tip = [`${c.type}: ${c.status}`, c.reason, c.message, c.lastTransitionTime ? `for ${formatAge(c.lastTransitionTime)}` : undefined]
          .filter(Boolean)
          .join(' · ');
        return (
          <Tooltip key={c.type} title={tip}>
            <Chip
              label={c.type}
              size="small"
              variant="outlined"
              color={unknown ? 'default' : healthy ? 'success' : 'error'}
              sx={healthy && !unknown ? { color: 'text.secondary' } : undefined}
            />
          </Tooltip>
        );
      })}
    </>
  );
}

export function ConditionsTable({ obj, goodWhen }: { obj: KubeObject; goodWhen?: (type: string) => 'True' | 'False' }) {
  const conditions = objConditions(obj);
  if (!conditions.length) return null;
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Conditions
      </Typography>
      <ConditionRows conditions={conditions} goodWhen={goodWhen} />
    </Box>
  );
}

/** ConditionsTable body without the heading, for use inside a Section. */
export function ConditionRows({ conditions, goodWhen }: { conditions: Condition[]; goodWhen?: (type: string) => 'True' | 'False' }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Type</TableCell>
          <TableCell>Status</TableCell>
          <TableCell>Reason</TableCell>
          <TableCell>Message</TableCell>
          <TableCell>Since</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {conditions.map((c) => {
          const expected = goodWhen?.(c.type) ?? 'True';
          const display = c.status === 'Unknown' ? 'Unknown' : c.status === expected ? 'Ready' : 'NotReady';
          return (
            <TableRow key={c.type}>
              <TableCell>{c.type}</TableCell>
              <TableCell>
                <StatusChip status={display} label={c.status} />
              </TableCell>
              <TableCell>{c.reason ?? ''}</TableCell>
              <TableCell sx={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.message}>
                {c.message ?? ''}
              </TableCell>
              <TableCell>
                <AgeCell timestamp={c.lastTransitionTime} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function MetadataSection({ obj, ctx, defaultOpen = true }: { obj: KubeObject; ctx: string; defaultOpen?: boolean }) {
  return (
    <Section title="Metadata" defaultOpen={defaultOpen}>
      <Table size="small">
        <TableBody>
          <Row label="Name" value={obj.metadata.name} />
          {obj.metadata.namespace && <Row label="Namespace" value={obj.metadata.namespace} />}
          <Row label="Cluster" value={ctx} />
          <Row label="Kind" value={`${obj.kind ?? ''} (${obj.apiVersion ?? ''})`} />
          <TableRow>
            <TableCell sx={{ width: 140, color: 'text.secondary', border: 0 }}>Created</TableCell>
            <TableCell sx={{ border: 0 }}>
              <AgeCell timestamp={obj.metadata.creationTimestamp} /> ago
            </TableCell>
          </TableRow>
          <Row label="UID" value={obj.metadata.uid} />
        </TableBody>
      </Table>
    </Section>
  );
}

export function GenericDetail({ obj, ctx, hideConditions, children }: { obj: KubeObject; ctx: string; hideConditions?: boolean; children?: ReactNode }) {
  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <MetadataSection obj={obj} ctx={ctx} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      {!hideConditions && <ConditionsTable obj={obj} />}
      {children}
    </Stack>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableCell sx={{ width: 140, color: 'text.secondary', border: 0 }}>{label}</TableCell>
      <TableCell sx={{ border: 0, wordBreak: 'break-all' }}>{value}</TableCell>
    </TableRow>
  );
}
