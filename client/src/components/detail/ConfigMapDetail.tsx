import { useState } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { formatBytes } from '../format.js';
import { CopyValueButton } from '../CellCopy.js';
import { GenericDetail } from './GenericDetail.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';
import { b64ByteLength } from './data-editor.js';
import { UsedBySection, usedBySummary } from './UsedBySection.js';
import { useUsedBy } from '../../api/queries.js';

/** Lines of a value shown before "Show all". */
export const PREVIEW_LINES = 7;
/** Lines rendered even when expanded; longer values belong in the Data tab's editor. */
const MAX_PREVIEW_LINES = 400;

function stringEntries(obj: KubeObject, field: 'data' | 'binaryData'): Array<[string, string]> {
  const map = obj[field] as Record<string, unknown> | undefined;
  return Object.entries(map ?? {}).filter((kv): kv is [string, string] => typeof kv[1] === 'string');
}

/** Borderless key/size rows for data keys whose values are not shown (Secrets). */
export function DataKeyRows({ rows }: { rows: Array<{ key: string; size?: number; note?: string }> }) {
  return (
    <Table size="small">
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.note ?? ''}:${r.key}`}>
            <TableCell sx={{ border: 0, py: 0.25, pl: 0, fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{r.key}</TableCell>
            <TableCell align="right" sx={{ border: 0, py: 0.25, whiteSpace: 'nowrap', width: '1%' }}>
              <Typography variant="caption" color="text.secondary">
                {[r.note, r.size !== undefined ? formatBytes(r.size) : undefined].filter(Boolean).join(' · ')}
              </Typography>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One key with the first lines of its value; the rest a click away. */
function DataPreview({ name, value }: { name: string; value: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = value.split('\n');
  // A trailing newline is not a line of content.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const shown = expanded ? lines.slice(0, MAX_PREVIEW_LINES) : lines.slice(0, PREVIEW_LINES);
  const size = new TextEncoder().encode(value).length;
  return (
    <Box sx={{ px: 1.5, py: 1.25, minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Typography sx={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 600, minWidth: 0, wordBreak: 'break-all' }}>{name}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          {`${formatBytes(size)} · ${lines.length} line${lines.length === 1 ? '' : 's'}`}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <CopyValueButton text={value} label={`Copy value of ${name}`} />
      </Stack>
      <Box
        component="pre"
        sx={{
          m: 0,
          mt: 0.75,
          px: 1.25,
          py: 0.75,
          borderRadius: 1,
          bgcolor: 'action.hover',
          fontFamily: 'monospace',
          fontSize: 11.5,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: expanded ? 480 : undefined,
          overflow: 'auto',
        }}
      >
        {value === '' ? <Box component="span" sx={{ color: 'text.secondary' }}>(empty)</Box> : shown.join('\n')}
      </Box>
      {lines.length > PREVIEW_LINES && (
        <Link component="button" variant="caption" underline="hover" onClick={() => setExpanded((v) => !v)} sx={{ display: 'block', mt: 0.5, fontWeight: 550 }}>
          {expanded
            ? 'Show less'
            : lines.length > MAX_PREVIEW_LINES
              ? `Show the first ${MAX_PREVIEW_LINES} of ${lines.length} lines`
              : `Show all ${lines.length} lines`}
        </Link>
      )}
    </Box>
  );
}

export function ConfigMapDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const textKeys = stringEntries(obj, 'data');
  const binaryKeys = stringEntries(obj, 'binaryData');
  const total = textKeys.length + binaryKeys.length;
  const bytes =
    textKeys.reduce((sum, [, v]) => sum + new TextEncoder().encode(v).length, 0) + binaryKeys.reduce((sum, [, v]) => sum + b64ByteLength(v), 0);
  const target = { ctx, group: '', version: 'v1', plural: 'configmaps', kind: 'ConfigMap', name: obj.metadata.name, namespace: obj.metadata.namespace };
  // Same query as the Used by section below (shared cache), summarized for the tile.
  const usedBy = useUsedBy(target);
  const usedItems = usedBy.data?.items ?? [];
  // Workloads first; the pods they run are the detail line.
  const owners = usedItems.filter((i) => i.ref.kind !== 'Pod');
  const podsUsing = usedItems.filter((i) => i.ref.kind === 'Pod');

  return (
    <Box>
      <DetailStack sx={{ pb: 0 }}>
        <SummaryStrip
          items={[
            { label: 'Keys', value: String(total) },
            { label: 'Size', value: formatBytes(bytes) },
            {
              label: 'Used by',
              span: 2,
              value: usedBy.isLoading ? '…' : !usedItems.length ? 'Nothing' : usedBySummary(owners.length ? owners : podsUsing),
              detail: owners.length && podsUsing.length ? usedBySummary(podsUsing) : undefined,
            },
            obj.immutable === true && { label: 'Immutable', value: 'Yes', tone: 'warning', hint: 'Immutable ConfigMaps cannot be edited, only replaced.' },
          ]}
        />
        {total > 0 && (
          <Section title="Data" count={total} flush>
            <Stack divider={<Divider />}>
              {textKeys.map(([k, v]) => (
                <DataPreview key={k} name={k} value={v} />
              ))}
              {binaryKeys.length > 0 && (
                <Box sx={{ px: 1.5, py: 1 }}>
                  <DataKeyRows rows={binaryKeys.map(([k, v]) => ({ key: k, size: b64ByteLength(v), note: 'binary' }))} />
                </Box>
              )}
            </Stack>
          </Section>
        )}
        <UsedBySection target={target} emptyText="No pod or workload mounts or reads this ConfigMap." defaultOpen={false} />
      </DetailStack>
      <GenericDetail obj={obj} ctx={ctx} />
    </Box>
  );
}
