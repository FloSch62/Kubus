import { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { type Collection } from './data.js';
import { useResources } from './useResources.js';
import { Badge, Empty, Errors } from './components.js';
import { labCounts, labPhase, labPods, labRuntime, type Lab } from './labs.js';
import { key, object, string, type Located } from './model.js';
import { NodeTable } from './NodeTable.js';
import { NodeInspector } from './NodeInspector.js';
import { LabDetail } from './LabDetail.js';
import { Links, Services, Storage, Events } from './LabTables.js';
import { Files } from './Files.js';

export type WorkspaceView = 'Labs' | 'Nodes' | 'Links' | 'Files' | 'Access' | 'Storage' | 'Events';
const podsCollection: Collection[] = [{ group: '', version: 'v1', plural: 'pods' }];
const mapsCollection: Collection[] = [{ group: '', version: 'v1', plural: 'configmaps' }];
const runtimeCollections: Collection[] = [
  { group: '', version: 'v1', plural: 'services' },
  { group: '', version: 'v1', plural: 'persistentvolumeclaims' },
  { group: 'apps', version: 'v1', plural: 'deployments' },
];
const eventCollections: Collection[] = [{ group: '', version: 'v1', plural: 'events' }];
export function Workspace({
  labs,
  selectedLab,
  view,
  profiles,
  configs,
  refresh,
  attention,
  onOpenLab,
  onPlatform,
}: {
  labs: Lab[];
  selectedLab?: Lab;
  view: WorkspaceView;
  profiles: Located[];
  configs: Located[];
  refresh: number;
  attention: boolean;
  onOpenLab: (lab: Lab, view?: WorkspaceView) => void;
  onPlatform: () => void;
}) {
  const [selection, setSelection] = useState<string>();
  const [inspectorView, setInspectorView] = useState('Runtime');
  const wide = useMediaQuery('(min-width: 1160px)');
  const scope = { labs: labs.map(({ ctx, namespace }) => ({ ctx, namespace })) };
  const nodes = labs.flatMap((l) => l.nodes);
  const links = labs.flatMap((l) => l.links);
  const current = nodes.find((n) => key(n) === selection);
  const podState = useResources(podsCollection, scope, refresh, view !== 'Labs' || !!selectedLab || !!current);
  const mapState = useResources(mapsCollection, scope, refresh, view === 'Files' || !!current);
  const runtimeState = useResources(runtimeCollections, scope, refresh, ['Access', 'Storage', 'Events'].includes(view));
  const eventState = useResources(eventCollections, scope, refresh, view === 'Events');
  const pods = podState.snapshot.items.filter((p) => labs.some((l) => labPods(l, [p]).length));
  const resources = runtimeState.snapshot.items.filter((r) => labs.some((l) => labRuntime(r, l, pods)));
  const related = new Set(
    [...nodes, ...links, ...pods, ...resources, ...labs.flatMap((l) => l.topologies)].map((r) => r.metadata.uid).filter(Boolean),
  );
  const events = eventState.snapshot.items.filter((r) => related.has(string(object(r.involvedObject).uid, '')));
  const select = useCallback((n: Located, tab = 'Runtime') => {
    setSelection(key(n));
    setInspectorView(tab);
  }, []);
  const inspector = current && (
    <NodeInspector
      key={`${key(current)}/${inspectorView}`}
      node={current}
      pods={pods}
      profiles={profiles}
      configs={configs}
      maps={mapState.snapshot.items}
      links={links}
      initialTab={inspectorView}
      refresh={refresh}
      loading={podState.loading}
      onClose={() => setSelection(undefined)}
      onController={onPlatform}
      onOpenLab={() => {
        const lab = labs.find((l) => l.ctx === current.ctx && l.namespace === current.metadata.namespace);
        if (lab) onOpenLab(lab);
      }}
    />
  );
  const columns: GridColDef<Lab>[] = [
    {
      field: 'name',
      headerName: 'Lab',
      minWidth: 160,
      flex: 1,
      renderCell: ({ row }) => <Button onClick={() => onOpenLab(row)}>{row.name}</Button>,
    },
    {
      field: 'state',
      headerName: 'Readiness',
      width: 130,
      valueGetter: (_, l) => labPhase(l),
      renderCell: ({ value }) => <Badge value={String(value)} />,
    },
    {
      field: 'devices',
      headerName: 'Devices',
      width: 125,
      valueGetter: (_, l) => `${labCounts(l).ready}/${labCounts(l).nodes} ready`,
      renderCell: ({ row, value }) => <Button onClick={() => onOpenLab(row, 'Nodes')}>{String(value)}</Button>,
    },
    {
      field: 'links',
      headerName: 'Links',
      width: 85,
      valueGetter: (_, l) => l.links.length,
      renderCell: ({ row, value }) => <Button onClick={() => onOpenLab(row, 'Links')}>{String(value)}</Button>,
    },
    {
      field: 'authoring',
      headerName: 'Source',
      width: 180,
      valueGetter: (_, l) => (l.topologies.length ? `${l.topologies.length} Topology resource(s)` : 'Nodes & Links'),
    },
    { field: 'namespace', headerName: 'Namespace', width: 170 },
    { field: 'ctx', headerName: 'Cluster', minWidth: 180, flex: 1 },
  ];
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack direction="row" sx={{ px: 2, py: 1, gap: 1.5, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle2">{selectedLab ? selectedLab.name : 'All labs'}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {selectedLab
            ? `${selectedLab.ctx} / ${selectedLab.namespace}`
            : `${labs.length} namespaces · ${nodes.length} devices · ${links.length} links`}
        </Typography>
        {selectedLab && <Badge value={labPhase(selectedLab)} />}
        <Typography variant="caption" color="text.secondary">
          {view === 'Links' ? 'Live interfaces + Kubernetes status' : 'Selected Kubernetes scope'}
        </Typography>
      </Stack>
      <Errors snapshot={podState.snapshot} />
      {(view === 'Files' || !!current) && <Errors snapshot={mapState.snapshot} />}
      {['Access', 'Storage', 'Events'].includes(view) && <Errors snapshot={runtimeState.snapshot} />}
      <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
        <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
          {view === 'Labs' &&
            (selectedLab ? (
              <LabDetail lab={selectedLab} pods={pods} loading={podState.loading} onNode={select} selected={selection} />
            ) : labs.length ? (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                  Open a lab’s topology, or use Nodes, Links and Files to work across all labs. The scope selector applies to every
                  workspace view.
                </Typography>
                <Box sx={{ flex: 1, minHeight: 200 }}>
                  <DataGrid
                    density="compact"
                    disableRowSelectionOnClick
                    aria-label="Labs"
                    rows={labs}
                    columns={columns}
                    onRowDoubleClick={({ row }) => onOpenLab(row)}
                  />
                </Box>
              </>
            ) : (
              <Empty title="No labs in this selection">Select namespaces containing c9s Nodes, Links or Topologies.</Empty>
            ))}
          {view === 'Nodes' && (
            <NodeTable
              key={String(attention)}
              nodes={nodes}
              pods={pods}
              loading={podState.loading}
              onSelect={select}
              selected={selection}
              initialAttention={attention}
              onLab={(n) => {
                const l = labs.find((l) => l.ctx === n.ctx && l.namespace === n.metadata.namespace);
                if (l) onOpenLab(l);
              }}
            />
          )}
          {view === 'Links' && (
            <Links links={links} nodes={nodes} pods={pods} refresh={refresh} onNode={(n) => select(n, 'Networking')} fleet={!selectedLab} />
          )}
          {view === 'Files' && (
            <Files
              labs={labs}
              nodes={nodes}
              pods={pods}
              maps={mapState.snapshot.items}
              loading={mapState.loading}
              onNode={(n) => select(n, 'Files')}
            />
          )}
          {view === 'Access' && <Services services={resources.filter((r) => r.plural === 'services')} />}
          {view === 'Storage' && (
            <Storage
              claims={resources.filter((r) => r.plural === 'persistentvolumeclaims')}
              nodes={nodes}
              pods={pods}
              loading={runtimeState.loading}
            />
          )}
          {view === 'Events' && (
            <>
              <Errors snapshot={eventState.snapshot} />
              <Events events={events} loading={eventState.loading} />
            </>
          )}
        </Stack>
        {wide && inspector && (
          <Box sx={{ width: 380, flexShrink: 0, borderLeft: 1, borderColor: 'divider', minHeight: 0 }}>{inspector}</Box>
        )}
      </Stack>
      {!wide && (
        <Drawer
          anchor="right"
          open={!!current}
          onClose={() => setSelection(undefined)}
          slotProps={{ paper: { sx: { width: 400, maxWidth: '92vw' } } }}
        >
          {inspector}
        </Drawer>
      )}
    </Stack>
  );
}
