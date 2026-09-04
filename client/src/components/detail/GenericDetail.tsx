import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { gvkForKind, type KubeObject } from '@kubus/shared';
import { openNamespaceOverview } from '../../namespace-link.js';
import { UsedBySection } from './UsedBySection.js';
import { AgeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';
import { ClampedText } from './ClampedText.js';
import { Fact, FactLink, Facts } from './Facts.js';
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

// Annotation keys whose values are links by convention even without a
// scheme (`homepage: grafana.example.com`); anything else needs http(s)://.
const URL_KEY_RE = /(^|[/._-])(url|urls|link|links|homepage|website|docs?|documentation|dashboard|runbook|runbook_url|wiki|repo|repository|source)$/i;
const BARE_HOST_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;

/**
 * Href for values that are web links: an explicit http(s) URL anywhere, or a
 * bare host under a link-shaped key. Other schemes and garbage stay inert.
 */
export function safeHref(value: string, key?: string): string | undefined {
  const candidate = /^https?:\/\//i.test(value) ? value : key && URL_KEY_RE.test(key) && BARE_HOST_RE.test(value.trim()) ? `https://${value.trim()}` : undefined;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function ChipList({ items }: { items: Array<[string, string]> }) {
  return (
    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
      {items.map(([k, v]) => {
        const href = safeHref(v, k);
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
        <Fact label="Namespace">
          {obj.metadata.namespace && (
            <FactLink title={`Open the ${obj.metadata.namespace} namespace overview`} onClick={() => openNamespaceOverview(ctx, obj.metadata.namespace!)}>
              {obj.metadata.namespace}
            </FactLink>
          )}
        </Fact>
        <Fact label="Cluster">{ctx}</Fact>
        <Fact label="Kind">{[obj.kind, obj.apiVersion ? `(${obj.apiVersion})` : undefined].filter(Boolean).join(' ')}</Fact>
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

/** Kinds without a dedicated overview whose referrers are worth listing up top. */
const REVERSE_LINK_KINDS = new Set(['ServiceAccount', 'PersistentVolumeClaim', 'PersistentVolume', 'StorageClass', 'PriorityClass', 'IngressClass', 'RuntimeClass', 'Gateway']);

function apiGroupVersion(apiVersion: string | undefined): { group: string; version: string } {
  if (!apiVersion) return { group: '', version: '' };
  const slash = apiVersion.indexOf('/');
  return slash === -1 ? { group: '', version: apiVersion } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

export function GenericDetail({ obj, ctx, hideConditions, lead, children }: { obj: KubeObject; ctx: string; hideConditions?: boolean; lead?: ReactNode; children?: ReactNode }) {
  const kind = obj.kind ?? '';
  const { group, version } = apiGroupVersion(obj.apiVersion);
  return (
    <DetailStack>
      {lead}
      {REVERSE_LINK_KINDS.has(kind) && (
        <UsedBySection target={{ ctx, group, version, plural: gvkForKind(kind)?.plural ?? '', kind, name: obj.metadata.name, namespace: obj.metadata.namespace }} />
      )}
      <MetadataSection obj={obj} ctx={ctx} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      {!hideConditions && <ConditionsTable obj={obj} />}
      {children}
    </DetailStack>
  );
}

