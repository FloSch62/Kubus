import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { ConditionRows } from './GenericDetail.js';
import { FactLink } from './Facts.js';
import { conditionHealthy, nestedConditionGroups, type ConditionOwner } from './nested-conditions.js';
import { Section } from './Section.js';

type GoodWhen = (type: string) => 'True' | 'False';

/**
 * One card with a block per owner (a route's parent, a Gateway's listener):
 * a tinted header naming the owner, then its conditions in full. Opens by
 * itself while any owner has a condition that is not healthy.
 */
export function ConditionOwnersSection({
  title,
  owners,
  goodWhen,
  collapseWhenHealthy = false,
  emptyText,
}: {
  title: string;
  owners: ConditionOwner[];
  goodWhen?: GoodWhen;
  collapseWhenHealthy?: boolean;
  /** Shown instead of the blocks when there are no owners at all. */
  emptyText?: string;
}) {
  if (!owners.length && !emptyText) return null;
  const healthy = owners.filter((owner) => owner.conditions.length > 0 && owner.conditions.every((c) => conditionHealthy(c, goodWhen))).length;
  return (
    <Section
      title={title}
      count={owners.length}
      flush
      defaultOpen={!collapseWhenHealthy || healthy < owners.length}
      description={owners.length ? `${healthy} of ${owners.length} healthy` : undefined}
    >
      {owners.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
          {emptyText}
        </Typography>
      ) : (
        <Stack divider={<Divider />}>
          {owners.map((owner, i) => (
            <Box key={`${owner.label}:${i}`}>
              <Stack direction="row" sx={{ px: 1.5, py: 0.75, bgcolor: 'action.hover', alignItems: 'baseline', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
                <Typography component="div" variant="body2" sx={{ fontWeight: 600, minWidth: 0, wordBreak: 'break-word' }}>
                  {owner.onOpen ? <FactLink onClick={owner.onOpen}>{owner.label}</FactLink> : owner.label}
                </Typography>
                {owner.detail && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {owner.detail}
                  </Typography>
                )}
              </Stack>
              {owner.note && (
                <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
                  {owner.note}
                </Typography>
              )}
              {owner.conditions.length > 0 && <ConditionRows conditions={owner.conditions} goodWhen={goodWhen} />}
            </Box>
          ))}
        </Stack>
      )}
    </Section>
  );
}

/** Every nested condition list of a custom resource's status, one section per list. */
export function NestedConditionSections({ obj, goodWhen, exclude, collapseWhenHealthy }: { obj: KubeObject; goodWhen?: GoodWhen; exclude?: string[]; collapseWhenHealthy?: boolean }) {
  const groups = useMemo(() => nestedConditionGroups(obj.status, obj.metadata.namespace), [obj.status, obj.metadata.namespace]);
  const shown = exclude ? groups.filter((group) => !exclude.includes(group.field)) : groups;
  return (
    <>
      {shown.map((group) => (
        <ConditionOwnersSection key={group.field} title={group.title} owners={group.owners} goodWhen={goodWhen} collapseWhenHealthy={collapseWhenHealthy} />
      ))}
    </>
  );
}
