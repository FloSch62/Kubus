import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { TopologyGraph } from '../components/TopologyGraph.js';
import { useClustersStore } from '../state/clusters.js';

export function TopologyPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);

  if (selected.length === 0) {
    return (
      <EmptyState
        icon={<HubOutlinedIcon />}
        title="No cluster selected"
        subtitle="Pick one or more clusters from the switcher to view topology."
      />
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5 }}>
      <PageHeader title="Topology" icon={<AccountTreeOutlinedIcon />}>
        <Chip label="Connected resources only" variant="outlined" />
        {namespaces.length > 0 && <Chip label={`${namespaces.length} namespace${namespaces.length === 1 ? '' : 's'}`} variant="outlined" />}
      </PageHeader>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <TopologyGraph contexts={selected} namespaces={namespaces} hideDisconnected emptyTitle="No connected resource map found" />
      </Box>
    </Box>
  );
}
