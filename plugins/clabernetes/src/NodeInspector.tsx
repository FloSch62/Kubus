import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import SubjectIcon from '@mui/icons-material/Subject';
import { client } from './bridge.js';
import { Badge, Facts, Conditions, ResourceButton, SectionTitle } from './components.js';
import { PodActions } from './PodActions.js';
import { nodePods, nodeTargets, nodeStages, mountedClaims, profileFor } from './runtime.js';
import { object, phase, ref, string, type Located } from './model.js';
import { key } from './model.js';
import { NodeFiles } from './Files.js';
import { useInterfaces } from './useInterfaces.js';

export function NodeInspector({
  node,
  pods,
  profiles,
  configs,
  loading,
  onClose,
  onController,
  maps,
  links,
  initialTab = 'Runtime',
  refresh,
  onOpenLab,
}: {
  node: Located;
  pods: Located[];
  profiles: Located[];
  configs: Located[];
  loading: boolean;
  onClose: () => void;
  onController: () => void;
  maps: Located[];
  links: Located[];
  initialTab?: string;
  refresh: number;
  onOpenLab: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [inspection, setInspection] = useState(0);
  const [allInterfaces, setAllInterfaces] = useState(false);
  const interfaces = useInterfaces([node], pods, tab === 'Networking', refresh + inspection);
  const observation = interfaces.data[key(node)];
  const nodeLinks = links.filter(
    (l) =>
      l.ctx === node.ctx &&
      l.metadata.namespace === node.metadata.namespace &&
      ['A', 'B'].some((side) => object(l.spec?.[`endpoint${side}`]).nodeName === node.metadata.name),
  );
  const [error, setError] = useState('');
  const targets = nodeTargets(node, pods);
  const pod = nodePods(node, pods)[0];
  const stages = nodeStages(node);
  const blocked = stages.find((s) => s.state === 'Blocked' || s.state === 'Stale');
  const profile = profileFor(node, profiles);
  const management = object(node.status?.directManagement);
  const readLogs = (name: string) => {
    const target = name === 'device' ? targets.find((t) => !t.helper) : targets.find((t) => t.name === name);
    if (target) void client.openLogs({ ...ref(target.pod), container: target.name }).catch((e: Error) => setError(e.message));
  };
  return (
    <Stack component="aside" aria-label={`Node ${node.metadata.name}`} sx={{ height: '100%', bgcolor: 'background.paper', minWidth: 0 }}>
      <Box sx={{ p: 2, pb: 1.5 }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
          <Typography variant="h6" sx={{ flex: 1, overflowWrap: 'anywhere' }}>
            {node.metadata.name}
          </Typography>
          <ResourceButton resource={node} icon />
          <IconButton size="small" aria-label="Close node inspector" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
          <Badge value={phase(node)} />
          <Typography variant="caption" color="text.secondary">
            {string(node.spec?.kind)}
          </Typography>
        </Stack>
        <PodActions targets={targets} label={node.metadata.name} loading={loading} />
        <Button size="small" onClick={onOpenLab} sx={{ mt: 0.5 }}>
          Open lab · {node.metadata.namespace}
        </Button>
      </Box>
      <Tabs
        value={tab}
        onChange={(_, t: string) => setTab(t)}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Node inspector views"
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        {['Runtime', 'Networking', 'Files', 'Details'].map((t) => (
          <Tab key={t} label={t} value={t} sx={{ minWidth: 65, px: 1.25 }} />
        ))}
      </Tabs>
      <Stack spacing={2} sx={{ p: 2, overflow: 'auto', flex: 1, minHeight: 0 }}>
        {error && (
          <Alert severity="error" onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {tab === 'Runtime' && (
          <>
            <Box>
              <SectionTitle>Readiness pipeline</SectionTitle>
              <Stack direction="row" sx={{ mt: 1, justifyContent: 'space-between' }}>
                {stages.map((s) => (
                  <Tooltip
                    key={s.type}
                    title={`${s.state}${s.condition?.reason ? ` · ${s.condition.reason}` : ''}: ${s.condition?.message ?? s.hint}`}
                  >
                    <Stack
                      spacing={0.5}
                      sx={{
                        alignItems: 'center',
                        color: s.state === 'Ready' ? 'success.main' : s.state === 'Blocked' ? 'error.main' : 'text.disabled',
                      }}
                    >
                      {s.state === 'Ready' ? (
                        <CheckCircleOutlineIcon sx={{ fontSize: 21 }} />
                      ) : s.state === 'Blocked' ? (
                        <ErrorOutlineIcon sx={{ fontSize: 21 }} />
                      ) : (
                        <RadioButtonUncheckedIcon sx={{ fontSize: 21 }} />
                      )}
                      <Typography variant="caption" color="text.secondary">
                        {s.label}
                      </Typography>
                    </Stack>
                  </Tooltip>
                ))}
              </Stack>
            </Box>
            {blocked && (
              <Alert
                severity={blocked.state === 'Stale' ? 'info' : 'warning'}
                sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}
              >
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {blocked.label} · {blocked.state === 'Stale' ? 'Awaiting current generation' : (blocked.condition?.reason ?? 'Waiting')}
                </Typography>
                <Typography variant="caption" component="p">
                  {blocked.condition?.message}
                </Typography>
                <Typography variant="caption" component="p" sx={{ mt: 1 }}>
                  {blocked.hint}
                </Typography>
                {blocked.action === 'controller' ? (
                  <Button onClick={onController}>Open control plane</Button>
                ) : blocked.action === 'profile' ? (
                  profile && <ResourceButton resource={profile}>Inspect profile</ResourceButton>
                ) : (
                  targets.some((t) => (blocked.action === 'device' ? !t.helper : t.name === blocked.action)) && (
                    <Button startIcon={<SubjectIcon />} onClick={() => readLogs(blocked.action)}>
                      Read {blocked.action === 'device' ? 'device' : blocked.action} logs
                    </Button>
                  )
                )}
              </Alert>
            )}
            {!pod ? (
              <Alert severity="info">
                {loading ? 'Loading the device Pod…' : 'No device Pod yet. Check profile resolution, planning and Node events.'}
                {!loading && <Button onClick={onController}>Control plane</Button>}
              </Alert>
            ) : (
              <>
                <Box>
                  <SectionTitle>Device Pod</SectionTitle>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere', mb: 1 }}>
                    {pod.metadata.name}
                  </Typography>
                  <Facts
                    values={[
                      ['Worker', string(pod.spec?.nodeName, 'Not scheduled')],
                      ['Pod IP', string(pod.status?.podIP)],
                      ['Lab address', string(management.ipv4, string(management.ipv6))],
                      [
                        'Storage',
                        mountedClaims(pod).length ? `${mountedClaims(pod).length} mounted PVC(s)` : 'Ephemeral · replaced with Pod',
                      ],
                    ]}
                  />
                  <ResourceButton resource={pod}>Inspect Pod & events</ResourceButton>
                </Box>
                <Divider />
                <Box>
                  <SectionTitle>Containers</SectionTitle>
                  <Stack spacing={1} sx={{ mt: 0.75 }}>
                    {targets.map((t) => (
                      <Box key={t.name} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
                        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {t.role}
                          </Typography>
                          <Badge value={t.state} />
                        </Stack>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                          {t.helper ? t.name : t.image.includes('@sha256:') ? t.image.split('@sha256:')[0] : t.image}
                        </Typography>
                        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mt: 0.5 }}>
                          <Typography variant="caption" color="text.secondary">
                            {t.restarts} restarts{!t.helper ? ` · ${t.ready ? 'Ready' : 'Not ready'}` : ''}
                          </Typography>
                          <Button
                            size="small"
                            startIcon={<SubjectIcon />}
                            onClick={() =>
                              void client.openLogs({ ...ref(t.pod), container: t.name }).catch((e: Error) => setError(e.message))
                            }
                          >
                            Logs
                          </Button>
                        </Stack>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              </>
            )}
          </>
        )}
        {tab === 'Networking' && (
          <>
            <Box>
              <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <SectionTitle>Live interfaces</SectionTitle>
                <Button disabled={interfaces.loading} onClick={() => setInspection((v) => v + 1)}>
                  {interfaces.loading ? 'Checking…' : 'Check now'}
                </Button>
              </Stack>
              {observation?.error && <Alert severity="warning">{observation.error}</Alert>}
              {observation?.snapshot && (
                <Typography variant="caption" color="text.secondary">
                  Observed {new Date(observation.snapshot.observedAt).toLocaleTimeString()}
                </Typography>
              )}
              <Button size="small" onClick={() => setAllInterfaces((v) => !v)} aria-pressed={allInterfaces}>
                {allInterfaces ? 'Lab interfaces only' : 'Show all Linux interfaces'}
              </Button>
              {observation?.snapshot?.interfaces
                .filter(
                  (i) =>
                    allInterfaces ||
                    ['mgmt0', 'eth0', string(management.interfaceName, '')].includes(i.name) ||
                    nodeLinks.some((l) =>
                      ['A', 'B'].some((s) => {
                        const e = object(l.spec?.[`endpoint${s}`]);
                        return e.nodeName === node.metadata.name && e.interfaceName === i.name;
                      }),
                    ),
                )
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                .map((i) => (
                  <Box key={i.name} sx={{ borderBottom: 1, borderColor: 'divider', py: 0.75 }}>
                    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                        {i.name}
                      </Typography>
                      <Badge value={!i.adminUp ? 'Admin down' : i.carrier === true ? 'Up' : i.carrier === false ? 'Down' : 'Unknown'} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      MTU {i.mtu ?? '—'} · {i.address ?? '—'}
                    </Typography>
                  </Box>
                ))}
              {nodeLinks.map((l) => {
                const a = object(l.spec?.endpointA),
                  b = object(l.spec?.endpointB);
                return (
                  <Box key={key(l)} sx={{ mt: 1 }}>
                    <Typography variant="caption">
                      {string(a.nodeName)}:{string(a.interfaceName)} ↔ {string(b.nodeName)}:{string(b.interfaceName)}
                    </Typography>
                    <ResourceButton resource={l} icon />
                  </Box>
                );
              })}
            </Box>
            <Box>
              <SectionTitle>Management identity</SectionTitle>
              <Facts
                values={[
                  ['Interface', string(management.interfaceName)],
                  ['IPv4', string(management.ipv4)],
                  ['Gateway', string(management.ipv4Gateway)],
                  ['IPv6', string(management.ipv6)],
                  ['IPv6 gateway', string(management.ipv6Gateway)],
                  ['Pod transport', string(pod?.status?.podIP)],
                  ['External address', string(object(node.status?.exposedPorts).loadBalancerAddress)],
                ]}
              />
            </Box>
            <Alert severity="info">
              Use the management address from inside the lab. From outside, use an exposed Service or Kubus port forwarding.
            </Alert>
            <Box>
              <SectionTitle>Connectivity diagnostics</SectionTitle>
              <Typography variant="body2" color="text.secondary">
                Fabric cables use UDP 14790; the routed management mesh uses UDP 14789. Interface observations describe the sampled Linux
                state. The clabwire log reports peer sessions and failed invariants.
              </Typography>
              <Button
                disabled={!targets.some((t) => t.name === 'clabwire')}
                startIcon={<SubjectIcon />}
                onClick={() => readLogs('clabwire')}
              >
                Connectivity logs
              </Button>
            </Box>
          </>
        )}
        {tab === 'Files' && <NodeFiles node={node} pods={pods} maps={maps} />}
        {tab === 'Details' && (
          <>
            <Facts
              values={[
                ['Cluster', node.ctx],
                ['Namespace', node.metadata.namespace],
                ['Image', string(node.spec?.image)],
                [
                  'Profile',
                  profile ? (
                    <ResourceButton key="profile" resource={profile}>
                      {profile.metadata.name}
                    </ResourceButton>
                  ) : (
                    string(object(node.spec?.profileRef).name, 'Built-in / global defaults')
                  ),
                ],
                [
                  'Plan digest',
                  <Box key="digest" component="code" sx={{ fontSize: 10 }}>
                    {string(node.status?.planDigest)}
                  </Box>,
                ],
                ['Profile revision', string(object(node.status?.appliedProfile).generation)],
              ]}
            />
            <Box>
              <SectionTitle>Global configuration</SectionTitle>
              {configs
                .filter((c) => c.ctx === node.ctx)
                .map((c) => (
                  <ResourceButton key={c.metadata.namespace + '/' + c.metadata.name} resource={c}>
                    {c.metadata.namespace}/{c.metadata.name}
                  </ResourceButton>
                ))}
              <Button onClick={onController}>Global Config & Helm</Button>
            </Box>
            <SectionTitle>Reported conditions</SectionTitle>
            <Conditions conditions={node.status?.conditions} />
          </>
        )}
      </Stack>
    </Stack>
  );
}
