import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import type { KubeObject } from '@kubus/shared';
import { AgeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';
import { ClampedText } from './ClampedText.js';
import { Fact, Facts } from './Facts.js';
import { DetailStack, Section } from './Section.js';

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

export function ConditionsTable({ obj, goodWhen, defaultOpen = true }: { obj: KubeObject; goodWhen?: (type: string) => 'True' | 'False'; defaultOpen?: boolean }) {
  const conditions = objConditions(obj);
  if (!conditions.length) return null;
  return (
    <Section title="Conditions" count={conditions.length} defaultOpen={defaultOpen} flush>
      <ConditionRows conditions={conditions} goodWhen={goodWhen} />
    </Section>
  );
}

/**
 * ConditionsTable body without the heading, for use inside a flush Section.
 * One row per condition: type, status and reason on the first line, the
 * message in full underneath — a drawer is for reading, so nothing is
 * squeezed into an ellipsis.
 */
export function ConditionRows({ conditions, goodWhen }: { conditions: Condition[]; goodWhen?: (type: string) => 'True' | 'False' }) {
  return (
    <Stack divider={<Divider />}>
      {conditions.map((c) => {
        const expected = goodWhen?.(c.type) ?? 'True';
        const display = c.status === 'Unknown' ? 'Unknown' : c.status === expected ? 'Ready' : 'NotReady';
        return (
          <Box key={c.type} sx={{ px: 1.5, py: 1, minWidth: 0 }}>
            <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, flexShrink: 0 }}>
                {c.type}
              </Typography>
              <StatusChip status={display} label={c.status} />
              {c.reason && (
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0, wordBreak: 'break-word' }}>
                  {c.reason}
                </Typography>
              )}
              {c.lastTransitionTime && (
                <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  <AgeCell timestamp={c.lastTransitionTime} variant="caption" /> ago
                </Typography>
              )}
            </Stack>
            {c.message && <ClampedText text={c.message} lines={4} sx={{ mt: 0.25 }} />}
          </Box>
        );
      })}
    </Stack>
  );
}

export function MetadataSection({ obj, ctx, defaultOpen = true }: { obj: KubeObject; ctx: string; defaultOpen?: boolean }) {
  return (
    <Section title="Metadata" defaultOpen={defaultOpen}>
      <Facts>
        <Fact label="Name">{obj.metadata.name}</Fact>
        <Fact label="Namespace">{obj.metadata.namespace}</Fact>
        <Fact label="Cluster">{ctx}</Fact>
        <Fact label="Kind">{`${obj.kind ?? ''} (${obj.apiVersion ?? ''})`}</Fact>
        <Fact label="Created">
          <AgeCell timestamp={obj.metadata.creationTimestamp} /> ago
        </Fact>
        <Fact label="UID" mono>
          {obj.metadata.uid}
        </Fact>
      </Facts>
    </Section>
  );
}

export function GenericDetail({ obj, ctx, hideConditions, children }: { obj: KubeObject; ctx: string; hideConditions?: boolean; children?: ReactNode }) {
  return (
    <DetailStack>
      <MetadataSection obj={obj} ctx={ctx} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      {!hideConditions && <ConditionsTable obj={obj} />}
      {children}
    </DetailStack>
  );
}

