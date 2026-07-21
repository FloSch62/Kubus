import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import { useContexts } from '../api/queries.js';
import { ContextHealthDot } from './ContextHealthDot.js';

/** Header for one cluster's section on multi-cluster stacked pages (Overview, Metrics, Network). */
export function ClusterSectionHeader({ ctx, children }: { ctx: string; children?: React.ReactNode }) {
  // Ride on the cluster picker's polling — one header per cluster mounts here.
  const { data: contexts } = useContexts({ poll: false });
  const info = contexts?.find((c) => c.name === ctx);
  return (
    <Stack direction="row" spacing={1} sx={{ mb: 1.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
      <HubOutlinedIcon sx={{ fontSize: 18, color: 'primary.main' }} />
      <Typography variant="h6">{ctx}</Typography>
      <ContextHealthDot info={info} />
      {children}
    </Stack>
  );
}
