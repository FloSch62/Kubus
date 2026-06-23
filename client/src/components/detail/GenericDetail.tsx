import type { ReactNode } from 'react';
import { Box, Chip, Divider, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { KubeObject } from '@kubus/shared';
import { AgeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';

export function KeyValueChips({ title, entries }: { title: string; entries: Record<string, string> | undefined }) {
  const items = Object.entries(entries ?? {});
  if (!items.length) return null;
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <Stack direction="row" flexWrap="wrap" gap={0.5}>
        {items.map(([k, v]) => (
          <Chip key={k} label={`${k}=${v}`} variant="outlined" sx={{ maxWidth: 420 }} title={`${k}=${v}`} />
        ))}
      </Stack>
    </Box>
  );
}

export function ConditionsTable({ obj, goodWhen }: { obj: KubeObject; goodWhen?: (type: string) => 'True' | 'False' }) {
  const conditions = (obj.status as { conditions?: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }> })?.conditions;
  if (!conditions?.length) return null;
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Conditions
      </Typography>
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
    </Box>
  );
}

export function GenericDetail({ obj, ctx, hideConditions, children }: { obj: KubeObject; ctx: string; hideConditions?: boolean; children?: ReactNode }) {
  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Metadata
        </Typography>
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
      </Box>
      <KeyValueChips title="Labels" entries={obj.metadata.labels} />
      <KeyValueChips title="Annotations" entries={obj.metadata.annotations} />
      {!hideConditions && (
        <>
          <Divider />
          <ConditionsTable obj={obj} />
        </>
      )}
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
