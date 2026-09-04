import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { formatBytes } from '../format.js';
import { GenericDetail } from './GenericDetail.js';
import { Fact, Facts } from './Facts.js';
import { Section } from './Section.js';
import { b64ByteLength } from './data-editor.js';
import { statusTextColor } from '../../theme.js';
import { UsedBySection } from './UsedBySection.js';

function stringEntries(obj: KubeObject, field: 'data' | 'binaryData'): Array<[string, string]> {
  const map = obj[field] as Record<string, unknown> | undefined;
  return Object.entries(map ?? {}).filter((kv): kv is [string, string] => typeof kv[1] === 'string');
}

/** Borderless key/size rows for data keys — the values live in the Data tab. */
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

export function ConfigMapDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const textKeys = stringEntries(obj, 'data');
  const binaryKeys = stringEntries(obj, 'binaryData');
  const total = textKeys.length + binaryKeys.length;

  return (
    <Box>
      <Box sx={{ px: 2, pt: 2 }}>
        <Facts>
          <Fact label="Keys">{total}</Fact>
          <Fact label="Immutable" hint="Immutable ConfigMaps cannot be edited — only replaced.">
            {obj.immutable === true && (
              <Box component="span" sx={{ fontWeight: 550, color: statusTextColor('warning') }}>
                Yes
              </Box>
            )}
          </Fact>
        </Facts>
      </Box>
      <Box sx={{ px: 2, pt: 2 }}>
        <UsedBySection target={{ ctx, group: '', version: 'v1', plural: 'configmaps', kind: 'ConfigMap', name: obj.metadata.name, namespace: obj.metadata.namespace }} emptyText="No pod or workload mounts or reads this ConfigMap." />
      </Box>
      {total > 0 && (
        <Box sx={{ px: 2, pt: 2 }}>
          <Section title="Data keys" count={total}>
            <DataKeyRows
              rows={[
                ...textKeys.map(([k, v]) => ({ key: k, size: new TextEncoder().encode(v).length })),
                ...binaryKeys.map(([k, v]) => ({ key: k, size: b64ByteLength(v), note: 'binary' })),
              ]}
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              View and edit values per key in the Data tab.
            </Typography>
          </Section>
        </Box>
      )}
      <GenericDetail obj={obj} ctx={ctx} />
    </Box>
  );
}
