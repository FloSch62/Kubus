import { useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import { useContext } from './bridge.js';
import { catalog } from './data.js';
import { useResources } from './useResources.js';
import { Profiles } from './Profiles.js';
import { ControlPlane } from './ControlPlane.js';
import { Empty, Errors, Badge } from './components.js';
import { phase, tone } from './model.js';
import { discoverLabs, labPhase, type Lab } from './labs.js';
import { Workspace, type WorkspaceView } from './Workspace.js';
import { ViewPane } from './ViewPane.js';

const views = ['Labs', 'Nodes', 'Links', 'Files', 'Access', 'Storage', 'Events', 'Platform'] as const;
export function App() {
  const context = useContext();
  const [view, setView] = useState<WorkspaceView | 'Platform'>('Labs');
  const [platform, setPlatform] = useState('Installation');
  const [selected, setSelected] = useState<string>();
  const [attention, setAttention] = useState(false);
  const { snapshot, loading } = useResources(catalog);
  const labs = discoverLabs(snapshot.items);
  const nodes = snapshot.items.filter((r) => r.plural === 'nodes');
  const profiles = snapshot.items.filter((r) => r.plural === 'nodeprofiles');
  const configs = snapshot.items.filter((r) => r.plural === 'configs');
  const lab = labs.find((l) => l.id === selected);
  const scopedLabs = lab ? [lab] : labs;
  const count = scopedLabs.flatMap((l) => l.nodes).filter((n) => tone(phase(n)) !== 'good').length;
  const all = { id: '', name: 'All labs', ctx: '', namespace: '' };
  const options = [all, ...labs];
  const openLab = (next: Lab, nextView: WorkspaceView = 'Labs') => {
    setSelected(next.id);
    setView(nextView);
    setAttention(false);
  };
  const openPlatform = () => {
    setPlatform('Installation');
    setView('Platform');
  };
  return (
    <Stack sx={{ height: '100%', minWidth: 0, bgcolor: 'background.default' }}>
      <Stack direction="row" spacing={1.25} sx={{ px: 2, py: 1.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <HubOutlinedIcon color="primary" />
        <Typography component="h1" variant="h6">
          Clabernetes
        </Typography>
        <Chip label={`${labs.length} ${labs.length === 1 ? 'lab' : 'labs'} · ${nodes.length} devices`} variant="outlined" size="small" />
        <Box sx={{ flex: 1 }} />
        {view !== 'Platform' && (
          <Autocomplete
            size="small"
            disableClearable
            options={options}
            value={lab ?? all}
            getOptionLabel={(l) => (l.id ? `${l.name} · ${l.namespace}` : l.name)}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            getOptionKey={(l) => l.id}
            filterOptions={(items, state) =>
              items.filter((l) => `${l.name} ${l.ctx} ${l.namespace}`.toLowerCase().includes(state.inputValue.toLowerCase()))
            }
            onChange={(_, l) => {
              setSelected(l.id || undefined);
              setAttention(false);
            }}
            sx={{ width: 300 }}
            renderOption={(props, l) => (
              <Box component="li" {...props} key={l.id}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2">{l.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {l.id ? `${l.ctx} / ${l.namespace}` : 'Across selected clusters and namespaces'}
                  </Typography>
                </Box>
                {'nodes' in l && <Badge value={labPhase(l as Lab)} />}
              </Box>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Workspace scope"
                slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps?.htmlInput, 'aria-label': 'Workspace scope' } }}
              />
            )}
          />
        )}
      </Stack>
      <Stack direction="row" sx={{ alignItems: 'center', px: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Tabs
          value={view}
          onChange={(_, v: typeof view) => {
            setView(v);
            setAttention(false);
          }}
          aria-label="Clabernetes sections"
          variant="scrollable"
          scrollButtons="auto"
          sx={{ flex: 1, minWidth: 0 }}
        >
          {views.map((v) => (
            <Tab key={v} label={v === 'Labs' && lab ? 'Topology' : v} value={v} sx={{ minWidth: 65, px: 1.5 }} />
          ))}
        </Tabs>
        {count > 0 && view !== 'Platform' && (
          <Chip
            size="small"
            label={`${count} need attention`}
            color="warning"
            variant="outlined"
            onClick={() => {
              setView('Nodes');
              setAttention(true);
            }}
          />
        )}
      </Stack>
      <Errors snapshot={snapshot} />
      {!context.contexts.length ? (
        <Empty title="Connect a cluster to see your labs">This workspace follows the clusters and namespaces selected in Kubus.</Empty>
      ) : loading && !snapshot.updated ? (
        <>
          <LinearProgress />
          <Empty title="Discovering your labs…" />
        </>
      ) : (
        <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <ViewPane active={view !== 'Platform'}>
            <Workspace
              key={lab?.id ?? 'all'}
              labs={scopedLabs}
              selectedLab={lab}
              view={view === 'Platform' ? 'Labs' : view}
              profiles={profiles}
              configs={configs}
              attention={attention}
              onOpenLab={openLab}
              onPlatform={openPlatform}
            />
          </ViewPane>
          {view === 'Platform' && (
            <>
              <Stack direction="row" sx={{ px: 2, alignItems: 'center', gap: 2 }}>
                <Tabs value={platform} onChange={(_, v: string) => setPlatform(v)} aria-label="Platform views">
                  <Tab label="Installation & global Config" value="Installation" />
                  <Tab label="NodeProfiles" value="Profiles" />
                </Tabs>
                <Typography variant="caption" color="text.secondary">
                  Across selected clusters and namespaces
                </Typography>
              </Stack>
              {platform === 'Profiles' ? <Profiles profiles={profiles} nodes={nodes} /> : <ControlPlane configs={configs} />}
            </>
          )}
        </Box>
      )}
    </Stack>
  );
}
