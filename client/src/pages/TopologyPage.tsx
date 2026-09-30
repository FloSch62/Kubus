import { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { NoClustersState } from '../components/NoClustersState.js';
import { PageHeader } from '../components/PageHeader.js';
import { TopologyGraph, type TopologyStats } from '../components/TopologyGraph.js';
import { useClustersStore } from '../state/clusters.js';

const VIEW_KEY = 'kubus-topology-view';

const countLabel = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface TopologyView {
  onlyConnected: boolean;
  foldReplicaSets: boolean;
}

function readView(): TopologyView {
  const fallback = { onlyConnected: true, foldReplicaSets: true };
  try {
    const stored = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as Partial<TopologyView> | null;
    return { ...fallback, ...stored };
  } catch {
    return fallback;
  }
}

function writeView(view: TopologyView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Storage may be unavailable (private window); the view still works for this session.
  }
}

export function TopologyPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const namespacesByContext = useClustersStore((s) => s.namespacesByContext);
  const [view, setView] = useState(readView);
  const [stats, setStats] = useState<TopologyStats>();

  const update = useCallback((patch: Partial<TopologyView>) => {
    setView((current) => {
      const next = { ...current, ...patch };
      writeView(next);
      return next;
    });
  }, []);
  const onFoldReplicaSetsChange = useCallback((fold: boolean) => update({ foldReplicaSets: fold }), [update]);

  if (selected.length === 0) {
    return <NoClustersState icon={<AccountTreeOutlinedIcon />} />;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5 }}>
      <PageHeader title="Topology" icon={<AccountTreeOutlinedIcon />}>
        {stats && <Chip label={`${countLabel(stats.resources, 'resource')} · ${countLabel(stats.links, 'link')}`} variant="outlined" />}
        {stats && stats.issues > 0 && <Chip label={countLabel(stats.issues, 'issue')} color="warning" variant="outlined" />}
        {namespaces.length > 0 && <Chip label={`${namespaces.length} namespace${namespaces.length === 1 ? '' : 's'}`} variant="outlined" />}
        <Box sx={{ flex: 1 }} />
        <FormControlLabel
          control={<Switch size="small" checked={view.onlyConnected} onChange={(_e, checked) => update({ onlyConnected: checked })} />}
          label="Only connected"
          sx={{ mr: 0.5, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
        />
        <FormControlLabel
          control={<Switch size="small" checked={!view.foldReplicaSets} onChange={(_e, checked) => update({ foldReplicaSets: !checked })} />}
          label="Old ReplicaSets"
          sx={{ mr: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
        />
      </PageHeader>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <TopologyGraph
          contexts={selected}
          namespaces={namespacesByContext}
          hideDisconnected={view.onlyConnected}
          foldReplicaSets={view.foldReplicaSets}
          onFoldReplicaSetsChange={onFoldReplicaSetsChange}
          onStats={setStats}
          emptyTitle={view.onlyConnected ? 'No connected resource map found' : 'No resources found'}
        />
      </Box>
    </Box>
  );
}
