import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { NoClustersState } from '../components/NoClustersState.js';
import { PageHeader } from '../components/PageHeader.js';
import { TopologyGraph } from '../components/TopologyGraph.js';
import { useClustersStore } from '../state/clusters.js';

export function TopologyPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const namespacesByContext = useClustersStore((s) => s.namespacesByContext);

  if (selected.length === 0) {
    return <NoClustersState icon={<AccountTreeOutlinedIcon />} />;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5 }}>
      <PageHeader title="Topology" icon={<AccountTreeOutlinedIcon />}>
        <Chip label="Connected resources only" variant="outlined" />
        {namespaces.length > 0 && <Chip label={`${namespaces.length} namespace${namespaces.length === 1 ? '' : 's'}`} variant="outlined" />}
      </PageHeader>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <TopologyGraph contexts={selected} namespaces={namespacesByContext} hideDisconnected emptyTitle="No connected resource map found" />
      </Box>
    </Box>
  );
}
