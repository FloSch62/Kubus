import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { KeyValueSection, MetadataSection } from './GenericDetail.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';

interface LimitItem {
  type?: string;
  min?: Record<string, string>;
  max?: Record<string, string>;
  default?: Record<string, string>;
  defaultRequest?: Record<string, string>;
  maxLimitRequestRatio?: Record<string, string>;
}

const COLUMNS: Array<{ key: keyof Omit<LimitItem, 'type'>; label: string; hint: string }> = [
  { key: 'defaultRequest', label: 'Default request', hint: 'Applied to containers that set no request.' },
  { key: 'default', label: 'Default limit', hint: 'Applied to containers that set no limit.' },
  { key: 'min', label: 'Min', hint: 'Smallest request or limit the namespace accepts.' },
  { key: 'max', label: 'Max', hint: 'Largest request or limit the namespace accepts.' },
  { key: 'maxLimitRequestRatio', label: 'Max limit/request', hint: 'Limit may be at most this many times the request.' },
];

/** Resources mentioned anywhere in one limit item, cpu and memory first. */
export function limitResources(item: LimitItem): string[] {
  const names = new Set<string>();
  for (const { key } of COLUMNS) for (const name of Object.keys(item[key] ?? {})) names.add(name);
  const rank = (name: string) => (name === 'cpu' ? 0 : name === 'memory' ? 1 : 2);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * A LimitRange as one table per type (Container, Pod, PersistentVolumeClaim):
 * each resource against its defaults and bounds, so "why did my pod get a
 * 100m request" and "why was 8Gi rejected" read off the same rows.
 */
export function LimitRangeDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const items = ((obj.spec as { limits?: LimitItem[] } | undefined)?.limits ?? []).filter((item) => limitResources(item).length > 0);
  const types = items.map((item) => item.type ?? 'Container');
  const withDefaults = items.filter((item) => Object.keys(item.default ?? {}).length || Object.keys(item.defaultRequest ?? {}).length).length;
  const withBounds = items.filter((item) => Object.keys(item.min ?? {}).length || Object.keys(item.max ?? {}).length).length;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Applies to', value: types.length ? types.join(', ') : 'nothing', span: 2 },
          { label: 'Defaults', value: withDefaults ? `${withDefaults} type${withDefaults === 1 ? '' : 's'}` : 'none', hint: 'Types that inject requests or limits into objects that omit them.' },
          { label: 'Bounds', value: withBounds ? `${withBounds} type${withBounds === 1 ? '' : 's'}` : 'none', hint: 'Types with a minimum or maximum that rejects objects outside it.' },
        ]}
      />
      {items.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          This LimitRange sets no limits.
        </Typography>
      )}
      {items.map((item, i) => {
        const type = item.type ?? 'Container';
        const columns = COLUMNS.filter((c) => Object.keys(item[c.key] ?? {}).length > 0);
        return (
          <Section key={`${type}:${i}`} title={type} flush description={`${limitResources(item).length} resource${limitResources(item).length === 1 ? '' : 's'}`}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Resource</TableCell>
                  {columns.map((c) => (
                    <TableCell key={c.key} align="right" title={c.hint}>
                      {c.label}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {limitResources(item).map((resource) => (
                  <TableRow key={resource}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{resource}</TableCell>
                    {columns.map((c) => (
                      <TableCell key={c.key} align="right" sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {item[c.key]?.[resource] ?? (
                          <Typography component="span" variant="caption" color="text.disabled">
                            —
                          </Typography>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        );
      })}
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
    </DetailStack>
  );
}
