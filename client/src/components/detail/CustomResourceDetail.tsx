import { useMemo } from 'react';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { evalPrinterColumnPath } from '@kubus/shared';
import { RelativeTimeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';
import { statusLikeName } from '../../kube-display.js';
import { ConditionsTable, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { Fact, Facts } from './Facts.js';
import { Section } from './Section.js';
import { UsedBySection } from './UsedBySection.js';
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
  const names = useMemo(() => crdNames(crd), [crd]);
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
          <Facts>
            {rows.map((row) => (
              <Fact key={row.label} label={row.label} hint={row.description}>
                <StatusRowValue row={row} />
              </Fact>
            ))}
          </Facts>
        </Section>
      )}
      <ConditionsTable obj={obj} />
      {names && (
        <UsedBySection
          target={{ ctx, group: names.group, version, plural: names.plural, kind: obj.kind ?? names.kind, name: obj.metadata.name, namespace: obj.metadata.namespace }}
          emptyText={`Nothing references this ${obj.kind ?? names.kind}.`}
        />
      )}
      <MetadataSection obj={obj} ctx={ctx} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
    </Stack>
  );
}

/** Group, plural and kind of the CRD backing a custom object, for the reverse-link lookup. */
function crdNames(crd: KubeObject): { group: string; plural: string; kind: string } | undefined {
  const spec = crd.spec as { group?: string; names?: { plural?: string; kind?: string } } | undefined;
  return spec?.group && spec.names?.plural && spec.names.kind ? { group: spec.group, plural: spec.names.plural, kind: spec.names.kind } : undefined;
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
    // Direction-aware: expiry/renewal fields are future timestamps and used
    // to collapse into a meaningless "0s ago".
    return <RelativeTimeCell timestamp={row.value} />;
  }
  if (statusLikeName(row.label)) return <StatusChip status={row.value} />;
  return <Typography variant="body2">{row.value}</Typography>;
}
