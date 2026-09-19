import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import { useInterfaces } from './useInterfaces.js';
import { endpointState, observedLinkState } from './interfaces.js';
import Tooltip from '@mui/material/Tooltip';
import { linkWiring } from './labs.js';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { Badge, Empty, gridProps, ResourceButton } from './components.js';
import { age, object, phase, string, type Located } from './model.js';
import { mountedClaims, nodePods, records } from './runtime.js';

function Grid({ rows, columns, label }: { rows: Located[]; columns: GridColDef<Located>[]; label: string }) {
  return (
    <Box sx={{ flex: 1, minHeight: 240 }}>
      <DataGrid
        {...gridProps}
        aria-label={label}
        rows={rows}
        columns={columns}
        rowHeight={48}
        columnHeaderHeight={36}
        sx={{ '& .MuiDataGrid-cell': { display: 'flex', alignItems: 'center' } }}
      />
    </Box>
  );
}
export function Links({
  links,
  nodes,
  pods,
  refresh,
  onNode,
  fleet = false,
}: {
  links: Located[];
  nodes: Located[];
  pods: Located[];
  refresh: number;
  onNode: (node: Located) => void;
  fleet?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [details, setDetails] = useState(false);
  const [inspection, setInspection] = useState(0);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const endpoints = nodes.filter((n) =>
    links.some(
      (l) =>
        l.ctx === n.ctx &&
        l.metadata.namespace === n.metadata.namespace &&
        ['A', 'B'].some((side) => object(l.spec?.[`endpoint${side}`]).nodeName === n.metadata.name),
    ),
  );
  const observed = useInterfaces(endpoints, pods, true, refresh + inspection);
  const states = new Map(
    links.map((l) => {
      const a = endpointState(l, 'A', nodes, observed.data),
        b = endpointState(l, 'B', nodes, observed.data);
      return [l, { a, b, label: observedLinkState(a.label, b.label) }];
    }),
  );
  const rows = links.filter(
    (l) =>
      (!onlyProblems || states.get(l)?.label !== 'Up') &&
      `${l.metadata.name} ${l.metadata.namespace} ${l.ctx} ${string(object(l.spec?.endpointA).nodeName)} ${string(object(l.spec?.endpointB).nodeName)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const up = [...states.values()].filter((s) => s.label === 'Up').length;
  const failures = Object.values(observed.data).filter((o) => o.error).length;
  const columns: GridColDef<Located>[] = [
    {
      field: 'live',
      headerName: 'Live state',
      width: 120,
      valueGetter: (_, l) => states.get(l)?.label,
      renderCell: ({ value, row }) => (
        <Tooltip title={`${states.get(row)?.a.detail} · ${states.get(row)?.b.detail}`}>
          <Box>
            <Badge value={String(value)} />
          </Box>
        </Tooltip>
      ),
    },
    ...(['A', 'B'] as const).map(
      (side): GridColDef<Located> => ({
        field: `endpoint${side}`,
        headerName: `Endpoint ${side}`,
        flex: 1,
        minWidth: 220,
        valueGetter: (_, l) =>
          `${string(object(l.spec?.[`endpoint${side}`]).nodeName)}:${string(object(l.spec?.[`endpoint${side}`]).interfaceName)}`,
        renderCell: ({ row, value }) => {
          const node = nodes.find(
            (n) =>
              n.ctx === row.ctx &&
              n.metadata.namespace === row.metadata.namespace &&
              n.metadata.name === object(row.spec?.[`endpoint${side}`]).nodeName,
          );
          const state = side === 'A' ? states.get(row)?.a : states.get(row)?.b;
          return (
            <Stack direction="row" sx={{ alignItems: 'center', minWidth: 0, gap: 0.5 }}>
              {node ? (
                <Button onClick={() => onNode(node)}>{String(value)}</Button>
              ) : (
                <Typography variant="body2">{String(value)}</Typography>
              )}
              <Tooltip title={state?.detail ?? ''}>
                <Box>
                  <Badge value={state?.label ?? 'Unknown'} />
                </Box>
              </Tooltip>
            </Stack>
          );
        },
      }),
    ),
    { field: 'namespace', headerName: 'Lab namespace', width: 145, valueGetter: (_, r) => r.metadata.namespace },
    { field: 'ctx', headerName: 'Cluster', width: 180 },
    {
      field: 'accepted',
      headerName: 'Configuration',
      width: 130,
      valueGetter: (_, l) => phase(l),
      renderCell: ({ value }) => <Badge value={String(value)} />,
    },
    {
      field: 'wiring',
      headerName: 'Reconciliation',
      width: 135,
      valueGetter: (_, l) => linkWiring(l, nodes).label,
      renderCell: ({ row }) => (
        <Tooltip title={linkWiring(row, nodes).detail}>
          <Box>
            <Badge value={linkWiring(row, nodes).label} />
          </Box>
        </Tooltip>
      ),
    },
    { field: 'wire', headerName: 'Wire ID', width: 85, valueGetter: (_, l) => string(l.status?.wireID) },
    { field: 'mtu', headerName: 'Desired MTU', width: 110, valueGetter: (_, l) => string(l.spec?.mtu, '9500') },
    {
      field: 'actions',
      headerName: '',
      width: 50,
      sortable: false,
      filterable: false,
      renderCell: ({ row }) => <ResourceButton resource={row} icon />,
    },
  ];
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack direction="row" sx={{ px: 1.5, py: 1, gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="subtitle2">Links</Typography>
        <Chip size="small" variant="outlined" label={`${up}/${links.length} up`} />
        <Button onClick={() => setOnlyProblems((v) => !v)} aria-pressed={onlyProblems}>
          {onlyProblems ? 'Show all links' : 'Needs attention'}
        </Button>
        <Button onClick={() => setDetails((v) => !v)} aria-pressed={details}>
          Kubernetes details
        </Button>
        <Box sx={{ flex: 1 }} />
        <TextField size="small" label="Find a link" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ width: 200 }} />
        <Button disabled={observed.loading} onClick={() => setInspection((n) => n + 1)}>
          {observed.loading ? 'Checking interfaces…' : 'Check now'}
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ px: 2, pb: 1 }}>
        Live state is sampled from each device’s Linux interface: administrative state and carrier. It does not measure packet delivery or
        routing convergence. Select an endpoint for interfaces and connectivity logs.
      </Typography>
      {!!failures && (
        <Alert severity="warning" sx={{ mx: 1.5, mb: 1 }}>
          {failures} device inspection(s) unavailable. Hover an endpoint for the reason. Interface inspection requires Pod exec access and
          iproute2 in the application container.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 220 }}>
        <DataGrid
          {...gridProps}
          aria-label="Lab links"
          rows={rows}
          columns={columns}
          columnVisibilityModel={{
            namespace: fleet,
            ctx: fleet && (details || new Set(nodes.map((n) => n.ctx)).size > 1),
            accepted: details,
            wiring: details,
            wire: details,
            mtu: details,
          }}
          sx={{ '& .MuiDataGrid-cell': { display: 'flex', alignItems: 'center' } }}
          localeText={{ noRowsLabel: links.length ? 'No links match your filters' : 'No Link resources in this scope' }}
        />
      </Box>
    </Stack>
  );
}
export function Services({ services }: { services: Located[] }) {
  const columns = useMemo<GridColDef<Located>[]>(
    () => [
      { field: 'name', headerName: 'Service', minWidth: 165, flex: 1, valueGetter: (_, r) => r.metadata.name },
      { field: 'namespace', headerName: 'Namespace', width: 140, valueGetter: (_, r) => r.metadata.namespace },
      { field: 'ctx', headerName: 'Cluster', width: 180 },
      {
        field: 'purpose',
        headerName: 'Purpose',
        width: 130,
        valueGetter: (_, r) => r.metadata.labels?.['c9s.run/topologyServiceType'] ?? string(r.spec?.type),
      },
      {
        field: 'address',
        headerName: 'Address',
        minWidth: 155,
        flex: 1,
        valueGetter: (_, r) =>
          records(object(r.status?.loadBalancer).ingress)
            .map((v) => string(v.ip, string(v.hostname)))
            .join(', ') || (r.spec?.type === 'LoadBalancer' ? 'External IP pending' : string(r.spec?.clusterIP)),
        cellClassName: 'mono',
      },
      {
        field: 'ports',
        headerName: 'Service → device ports',
        minWidth: 230,
        flex: 1,
        valueGetter: (_, r) =>
          records(r.spec?.ports)
            .map((p) => `${string(p.port)} → ${string(p.targetPort)}/${string(p.protocol, 'TCP')}`)
            .join(' · '),
        renderCell: ({ value }) => (
          <Typography variant="caption" sx={{ lineHeight: 1.4, whiteSpace: 'normal' }}>
            {value as string}
          </Typography>
        ),
      },
      {
        field: 'actions',
        headerName: 'Access',
        width: 155,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => <ResourceButton resource={row}>Inspect / forward</ResourceButton>,
      },
    ],
    [],
  );
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Exposed services reach the actual device. Open a Service in Kubus to inspect endpoints or start a port forward.
      </Typography>
      {services.length ? (
        <Grid rows={services} columns={columns} label="Lab services" />
      ) : (
        <Empty title="No services">Exposure may be disabled or still reconciling.</Empty>
      )}
    </Stack>
  );
}
export function Storage({ claims, nodes, pods, loading }: { claims: Located[]; nodes: Located[]; pods: Located[]; loading: boolean }) {
  const ephemeral = nodes.filter((n) => {
    const p = nodePods(n, pods)[0];
    return p && !mountedClaims(p).length;
  });
  const columns = useMemo<GridColDef<Located>[]>(
    () => [
      {
        field: 'name',
        headerName: 'Claim',
        flex: 1,
        minWidth: 130,
        valueGetter: (_, c) => c.metadata.name,
        renderCell: ({ row }) => <ResourceButton resource={row}>{row.metadata.name}</ResourceButton>,
      },
      {
        field: 'status',
        headerName: 'Status',
        width: 100,
        valueGetter: (_, c) => phase(c),
        renderCell: ({ value }) => <Badge value={value as string} />,
      },
      { field: 'capacity', headerName: 'Capacity', width: 90, valueGetter: (_, c) => string(object(c.status?.capacity).storage) },
      { field: 'namespace', headerName: 'Namespace', width: 140, valueGetter: (_, c) => c.metadata.namespace },
      { field: 'ctx', headerName: 'Cluster', width: 180 },
      {
        field: 'class',
        headerName: 'Storage class',
        flex: 1,
        minWidth: 120,
        valueGetter: (_, c) => string(c.spec?.storageClassName, 'Default'),
      },
      {
        field: 'retention',
        headerName: 'Claim ownership',
        minWidth: 205,
        flex: 1,
        valueGetter: (_, c) =>
          c.metadata.ownerReferences?.length
            ? c.metadata.ownerReferences.map((o) => `${o.kind}/${o.name}`).join(', ')
            : 'Unowned · retained by c9s',
      },
      {
        field: 'mounts',
        headerName: 'Mounted by',
        flex: 1,
        minWidth: 130,
        valueGetter: (_, c) =>
          pods
            .filter((p) => mountedClaims(p).includes(c.metadata.name))
            .map((p) => p.metadata.name)
            .join(', ') || 'Not mounted',
      },
    ],
    [pods],
  );
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Alert severity={ephemeral.length ? 'warning' : 'info'} sx={{ m: 1.5 }}>
        {ephemeral.length
          ? `${ephemeral.length} device(s) have no mounted PVC: ${ephemeral.map((n) => n.metadata.name).join(', ')}. Saved configuration will not survive Pod replacement.`
          : 'Persistent lab directories protect saved device configuration across Pod replacement. Commit and save on the device; inspect preparation logs to see which files were preserved.'}
      </Alert>
      <Typography variant="caption" color="text.secondary" sx={{ px: 2, pb: 1 }}>
        Owned claims can be garbage-collected with their Node. Retain policy leaves the claim unowned. Enforced startup configuration and a
        device-state reset can replace saved files.
      </Typography>
      {claims.length ? (
        <Grid rows={claims} columns={columns} label="Lab storage" />
      ) : (
        <Empty title={loading ? 'Reading storage…' : 'No persistent claims'}>
          Check the NodeProfile’s deployment persistence policy. Resource access errors are shown above.
        </Empty>
      )}
    </Stack>
  );
}
export function Events({ events, loading }: { events: Located[]; loading: boolean }) {
  const columns = useMemo<GridColDef<Located>[]>(
    () => [
      { field: 'type', headerName: 'Level', width: 100, renderCell: ({ value }) => <Badge value={string(value)} /> },
      { field: 'reason', headerName: 'Reason', width: 180 },
      { field: 'namespace', headerName: 'Namespace', width: 140, valueGetter: (_, e) => e.metadata.namespace },
      { field: 'ctx', headerName: 'Cluster', width: 180 },
      { field: 'object', headerName: 'Object', width: 180, valueGetter: (_, e) => string(object(e.involvedObject).name) },
      {
        field: 'message',
        headerName: 'Message',
        minWidth: 300,
        flex: 1,
        renderCell: ({ value }) => (
          <Typography variant="caption" sx={{ whiteSpace: 'normal', lineHeight: 1.4 }}>
            {string(value)}
          </Typography>
        ),
      },
      { field: 'count', headerName: 'Count', width: 70 },
      {
        field: 'time',
        headerName: 'Last seen',
        width: 80,
        valueGetter: (_, e) => age(string(e.lastTimestamp, e.metadata.creationTimestamp)),
      },
    ],
    [],
  );
  const sorted = useMemo(
    () => [...events].sort((a, b) => string(b.lastTimestamp, '').localeCompare(string(a.lastTimestamp, ''))),
    [events],
  );
  return events.length ? (
    <Grid rows={sorted} columns={columns} label="Lab events" />
  ) : (
    <Empty title={loading ? 'Reading events…' : 'No recent events'}>No retained Kubernetes events match this lab’s resources.</Empty>
  );
}
