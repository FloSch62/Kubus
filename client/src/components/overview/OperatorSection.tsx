import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useNavigate } from 'react-router';
import { pluralLabel, type OperatorRollup } from '@kubus/shared';
import { statusTextColor } from '../../theme.js';
import { InventoryButton, InventoryRow } from './Attention.js';
import { ProblemCard, kindListPath } from './cards.js';
import { kindIcon } from './kind-icons.js';

/**
 * Installed-operator rollups (cert-manager, Argo, Flux, External Secrets, KEDA,
 * Gateway API routes, Karpenter): ready/total per resource kind as list
 * buttons, with the not-ready instances listed underneath as links.
 */
export function OperatorSection({ ctx, operators, scoped }: { ctx: string; operators: OperatorRollup[]; scoped?: boolean }) {
  const navigate = useNavigate();
  const shown = scoped ? operators.filter((op) => op.resources.some((r) => r.total > 0 || r.unavailable)) : operators;
  if (shown.length === 0) return null;

  return (
    <ProblemCard title="Operators" count={shown.length} anchor="operators">
      <Stack spacing={1.5}>
        {shown.map((op) => {
          const issues = op.resources.flatMap((r) => r.issues.map((issue) => ({ r, issue })));
          return (
            <Box key={op.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontWeight: 600, width: 120, flexShrink: 0, pt: 0.75 }}>
                {op.name}
              </Typography>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <InventoryRow>
                  {op.resources.map((r) => {
                    const notReady = r.unavailable ? 0 : r.total - r.ready;
                    return (
                      <InventoryButton
                        key={r.plural}
                        icon={kindIcon('')}
                        label={pluralLabel(r.kind)}
                        value={r.unavailable ? undefined : `${r.ready}/${r.total}`}
                        sub={r.unavailable ? 'unavailable' : undefined}
                        problem={notReady > 0 ? { text: `${notReady} not ready`, tone: 'warning' } : undefined}
                        title={r.unavailable ? 'Resource API unavailable on this cluster' : `${r.ready} of ${r.total} ready`}
                        onClick={() => navigate(kindListPath(r))}
                      />
                    );
                  })}
                </InventoryRow>
                {issues.length > 0 && (
                  <Box component="ul" sx={{ m: 0, mt: 0.75, p: 0, listStyle: 'none' }}>
                    {issues.map(({ r, issue }) => (
                      <Typography component="li" variant="body2" key={`${r.plural}/${issue.namespace}/${issue.name}`} sx={{ py: 0.25, overflowWrap: 'anywhere' }}>
                        <Link
                          component={RouterLink}
                          to={kindListPath(r, { sel: { ctx, namespace: issue.namespace || undefined, name: issue.name } })}
                          underline="hover"
                          sx={{ fontWeight: 600 }}
                        >
                          {issue.namespace ? `${issue.namespace}/` : ''}
                          {issue.name}
                        </Link>
                        <Box component="span" sx={{ color: statusTextColor('warning'), fontWeight: 600 }}>
                          {' '}
                          {issue.reason ?? 'NotReady'}
                        </Box>
                        {issue.message && (
                          <Typography component="span" variant="body2" color="text.secondary">
                            {' · '}
                            {issue.message}
                          </Typography>
                        )}
                      </Typography>
                    ))}
                  </Box>
                )}
              </Box>
            </Box>
          );
        })}
      </Stack>
    </ProblemCard>
  );
}
