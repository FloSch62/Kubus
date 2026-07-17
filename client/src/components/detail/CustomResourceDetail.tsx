import { useMemo } from 'react';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { evalPrinterColumnPath } from '@kubus/shared';
import { AgeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';
import { statusLikeName } from '../../kube-display.js';
import { ConditionsTable, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { Section } from './Section.js';
import { crdVersions } from './CrdDetail.js';

interface StatusRow {
  label: string;
  value: string;
  description?: string;
  date?: boolean;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SIMPLE_PATH_LEAF_RE = /^\.[A-Za-z0-9_.-]*\.([A-Za-z0-9_-]+)$/;

function scalarText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return undefined;
}

/** "Operational State" / "operationalState" / "operational-state" → "operationalstate". */
function normalizeName(name: string): string {
  return name.replace(/[\s_-]/g, '').toLowerCase();
}

/**
 * Overview for custom-resource instances: the CRD's own printer columns plus
 * any remaining scalar `.status` fields render as a Metadata-style Status
 * table — so kinds like EDA's Interface surface Operational State / Speed /
 * Last Change without any per-kind code.
 */
export function CustomResourceDetail({ obj, ctx, crd, version }: { obj: KubeObject; ctx: string; crd: KubeObject; version: string }) {
  const rows = useMemo<StatusRow[]>(() => {
    const versions = crdVersions(crd);
    const v = versions.find((entry) => entry.name === version) ?? versions[0];
    const out: StatusRow[] = [];
    // Printer columns first, in the CRD author's order.
    const covered = new Set<string>();
    for (const c of v?.additionalPrinterColumns ?? []) {
      if (!c.name || !c.jsonPath || c.jsonPath === '.metadata.creationTimestamp') continue;
      // Schema-defined fields stay visible even while unset ("—"), so a
      // resource without status yet still shows what to expect.
      const value = scalarText(evalPrinterColumnPath(obj, c.jsonPath)) ?? '';
      covered.add(normalizeName(c.name));
      const pathLeaf = SIMPLE_PATH_LEAF_RE.exec(c.jsonPath)?.[1];
      if (pathLeaf) covered.add(normalizeName(pathLeaf));
      out.push({ label: c.name, value, description: c.description, date: c.type === 'date' });
    }
    // Then scalar status fields the columns didn't already show (conditions
    // get their own table below).
    for (const [key, raw] of Object.entries((obj.status ?? {}) as Record<string, unknown>)) {
      if (key === 'conditions' || covered.has(normalizeName(key))) continue;
      const value = scalarText(raw);
      if (value === undefined || value === '') continue;
      out.push({ label: key, value });
    }
    return out;
  }, [crd, version, obj]);

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      {rows.length > 0 && (
        <Section title="Status">
          <Table size="small">
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell sx={{ width: 140, color: 'text.secondary', border: 0 }}>
                    {row.description ? (
                      <Tooltip title={row.description}>
                        <span>{row.label}</span>
                      </Tooltip>
                    ) : (
                      row.label
                    )}
                  </TableCell>
                  <TableCell sx={{ border: 0, wordBreak: 'break-all' }}>
                    <StatusRowValue row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
      <ConditionsTable obj={obj} />
      <MetadataSection obj={obj} ctx={ctx} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
    </Stack>
  );
}

function StatusRowValue({ row }: { row: StatusRow }) {
  if (!row.value) {
    return (
      <Typography variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  if ((row.date || ISO_TIMESTAMP_RE.test(row.value)) && ISO_TIMESTAMP_RE.test(row.value)) {
    return (
      <>
        <AgeCell timestamp={row.value} /> ago
      </>
    );
  }
  if (statusLikeName(row.label)) return <StatusChip status={row.value} />;
  return <Typography variant="body2">{row.value}</Typography>;
}
