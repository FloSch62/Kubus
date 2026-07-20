import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router';
import { pluralLabel, type OperatorRollup } from '@kubus/shared';
import { ProblemCard, kindListPath } from './cards.js';

/**
 * Installed-operator rollups (cert-manager, Argo, Flux, KEDA, Karpenter):
 * ready/total per resource kind, with the not-ready instances as chips.
 */
export function OperatorSection({ ctx, operators, scoped }: { ctx: string; operators: OperatorRollup[]; scoped?: boolean }) {
  const navigate = useNavigate();
  const shown = scoped ? operators.filter((op) => op.resources.some((r) => r.total > 0 || r.unavailable)) : operators;
  if (shown.length === 0) return null;

  return (
    <ProblemCard title="Operators">
      <Stack spacing={1}>
        {shown.map((op) => (
          <Box key={op.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ fontWeight: 600, width: 110, flexShrink: 0, pt: 0.5 }}>
              {op.name}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, flex: 1, minWidth: 0 }}>
              {op.resources.map((r) => {
                const degraded = !r.unavailable && r.ready < r.total;
                return (
                  <ButtonBase
                    key={r.plural}
                    onClick={() => navigate(kindListPath(r))}
                    title={r.unavailable ? 'Resource API unavailable on this cluster' : undefined}
                    sx={{
                      px: 1,
                      py: 0.5,
                      border: 1,
                      borderColor: degraded ? 'warning.main' : 'divider',
                      borderRadius: 1.5,
                      gap: 0.5,
                      '&:hover': { bgcolor: 'action.hover', borderColor: degraded ? 'warning.main' : 'primary.main' },
                    }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      {pluralLabel(r.kind)}
                    </Typography>
                    <Typography variant="caption" sx={{ fontWeight: 700, color: degraded ? 'warning.main' : r.unavailable ? 'text.disabled' : undefined }}>
                      {r.unavailable ? 'unavailable' : `${r.ready}/${r.total}`}
                    </Typography>
                  </ButtonBase>
                );
              })}
              {op.resources.flatMap((r) =>
                r.issues.map((issue) => (
                  <Chip
                    key={`${r.plural}/${issue.namespace}/${issue.name}`}
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={`${issue.namespace ? `${issue.namespace}/` : ''}${issue.name}: ${issue.reason ?? 'NotReady'}`}
                    title={issue.message}
                    onClick={() => navigate(kindListPath(r, { sel: { ctx, namespace: issue.namespace || undefined, name: issue.name } }))}
                  />
                )),
              )}
            </Box>
          </Box>
        ))}
      </Stack>
    </ProblemCard>
  );
}
