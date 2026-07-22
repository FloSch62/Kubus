import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import TerminalIcon from '@mui/icons-material/Terminal';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import type { ContainerUsage, KubeObject, PodEnvVar } from '@kubus/shared';
import { gvkForKind } from '@kubus/shared';
import { ConditionChips, KeyValueChips, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { CopyValueButton } from '../CellCopy.js';
import { PortForwardDialog } from '../PortForwardDialog.js';
import { PodProblems } from './PodProblems.js';
import { Section } from './Section.js';
import { ContainerCards, type ContainerCardData } from './ContainerCards.js';
import { ReadyCounter } from '../ReadyCounter.js';
import { StatusChip } from '../StatusChip.js';
import { AgeCell } from '../AgeCell.js';
import { containerResources, podDebugContainers, podSummary } from '../../kube-display.js';
import { usePodEnv, useResourceMetrics, useStopDebug } from '../../api/queries.js';
import { useDetailStore } from '../../state/detail.js';
import { showToast } from '../../state/toast.js';
import { useDockStore, dockTabId } from '../../state/dock.js';
import { statusTextColor } from '../../theme.js';

interface Probe {
  httpGet?: { path?: string; port?: number | string; scheme?: string };
  tcpSocket?: { port?: number | string };
  exec?: { command?: string[] };
  grpc?: { port?: number; service?: string };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
}

interface ContainerSpec {
  name: string;
  image?: string;
  restartPolicy?: string;
  ports?: Array<{ containerPort: number; protocol?: string; name?: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }>;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
}

interface ContainerStatus {
  name: string;
  ready?: boolean;
  started?: boolean;
  restartCount?: number;
  state?: Record<string, { reason?: string; message?: string }>;
  lastState?: { terminated?: { reason?: string; finishedAt?: string } };
}

interface VolumeSpec {
  name: string;
  [key: string]: unknown;
}

interface Toleration {
  key?: string;
  operator?: string;
  value?: string;
  effect?: string;
  tolerationSeconds?: number;
}

interface PodSpec {
  containers?: ContainerSpec[];
  initContainers?: ContainerSpec[];
  nodeName?: string;
  serviceAccountName?: string;
  volumes?: VolumeSpec[];
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
}

type RelatedKind = 'Node' | 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim' | 'ServiceAccount';

function containerCard(c: ContainerSpec, st: ContainerStatus | undefined, usage: ContainerUsage | undefined, kind?: 'init' | 'sidecar'): ContainerCardData {
  const stateKey = st?.state ? Object.keys(st.state)[0] : undefined;
  const reason = stateKey ? (st!.state![stateKey]?.reason ?? stateKey) : undefined;
  const last = st?.lastState?.terminated;
  return {
    name: c.name,
    image: c.image,
    kind,
    state: reason ? (reason === 'running' ? 'Running' : reason === 'waiting' ? 'Waiting' : reason === 'terminated' ? 'Terminated' : reason) : undefined,
    stateMessage: stateKey && stateKey !== 'running' ? st!.state![stateKey]?.message : undefined,
    restarts: st?.restartCount,
    lastRestart: last ? { reason: last.reason, at: last.finishedAt } : undefined,
    ports: (c.ports ?? []).map((p) => ({ port: p.containerPort, protocol: p.protocol, name: p.name })),
    resources: containerResources(c),
    usage: usage ? { cpuMilli: usage.cpuMilli, memBytes: usage.memBytes } : undefined,
  };
}

export function PodDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const spec = obj.spec as PodSpec | undefined;
  const status = obj.status as { phase?: string; podIP?: string; containerStatuses?: ContainerStatus[]; initContainerStatuses?: ContainerStatus[]; qosClass?: string } | undefined;
  // Conditions on finished pods are stale (Ready=False is expected there).
  const terminal = status?.phase === 'Succeeded' || status?.phase === 'Failed';
  const summary = podSummary(obj);
  const statusByName = new Map((status?.containerStatuses ?? []).map((c) => [c.name, c]));
  const initStatusByName = new Map((status?.initContainerStatuses ?? []).map((c) => [c.name, c]));
  const push = useDetailStore((s) => s.push);
  const namespace = obj.metadata.namespace;
  const [forwardPort, setForwardPort] = useState<number>();

  const metricsQuery = useResourceMetrics([ctx], 'pods');
  const usageByContainer = useMemo(() => {
    const snap = metricsQuery.data?.get(ctx);
    if (!snap?.available) return new Map<string, ContainerUsage>();
    const entry = snap.items.find((i) => i.namespace === namespace && i.name === obj.metadata.name);
    return new Map((entry?.containers ?? []).map((c) => [c.name, c]));
  }, [metricsQuery.data, ctx, namespace, obj.metadata.name]);

  const openRelated = (kind: RelatedKind, name: string) => {
    const gvk = gvkForKind(kind);
    if (!gvk) return;
    push({ ctx, group: gvk.group, version: gvk.version, plural: gvk.plural, kind, name, namespace: gvk.namespaced ? namespace : undefined });
  };

  // Restartable init containers are sidecars: they run alongside the app
  // containers, so they card with them; one-shot inits get their own section.
  const sidecars = (spec?.initContainers ?? []).filter((c) => c.restartPolicy === 'Always');
  const inits = (spec?.initContainers ?? []).filter((c) => c.restartPolicy !== 'Always');
  const mainCards = [
    ...(spec?.containers ?? []).map((c) => containerCard(c, statusByName.get(c.name), usageByContainer.get(c.name))),
    ...sidecars.map((c) => containerCard(c, initStatusByName.get(c.name), usageByContainer.get(c.name), 'sidecar')),
  ];
  const initCards = inits.map((c) => containerCard(c, initStatusByName.get(c.name), usageByContainer.get(c.name), 'init'));

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, alignItems: 'center' }}>
        <StatusChip status={summary.status} />
        <Chip label={<>Ready <ReadyCounter value={summary.ready} /></>} variant="outlined" />
        <Chip label={`Restarts ${summary.restarts}`} variant="outlined" />
        {status?.podIP && <Chip label={`IP ${status.podIP}`} variant="outlined" />}
        {spec?.nodeName && (
          <Chip label={`Node ${spec.nodeName}`} variant="outlined" clickable onClick={() => openRelated('Node', spec.nodeName!)} />
        )}
        {status?.qosClass && <Chip label={`QoS ${status.qosClass}`} variant="outlined" />}
        {spec?.serviceAccountName && (
          <Chip label={`SA ${spec.serviceAccountName}`} variant="outlined" clickable onClick={() => openRelated('ServiceAccount', spec.serviceAccountName!)} />
        )}
        {!terminal && <ConditionChips obj={obj} />}
      </Stack>
      <PodProblems obj={obj} ctx={ctx} />
      <Section title="Containers" count={mainCards.length}>
        <ContainerCards items={mainCards} onForwardPort={terminal ? undefined : setForwardPort} />
      </Section>
      {initCards.length > 0 && (
        <Section title="Init containers" count={initCards.length}>
          <ContainerCards items={initCards} />
        </Section>
      )}
      <DebugContainersSection obj={obj} ctx={ctx} />
      <ProbesSection spec={spec} statusByName={new Map([...initStatusByName, ...statusByName])} terminal={terminal} />
      {namespace && <EnvSection ctx={ctx} namespace={namespace} pod={obj.metadata.name} onOpenRef={openRelated} />}
      <VolumesSection spec={spec} onOpenRef={openRelated} />
      <SchedulingSection spec={spec} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
      {forwardPort !== undefined && (
        <PortForwardDialog ctx={ctx} kind="Pod" obj={obj} initialRemotePort={forwardPort} onClose={() => setForwardPort(undefined)} />
      )}
    </Stack>
  );
}

function DebugContainersSection({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const debugContainers = podDebugContainers(obj);
  const stop = useStopDebug();
  const addTab = useDockStore((s) => s.addTab);
  if (!debugContainers.length) return null;
  const namespace = obj.metadata.namespace ?? '';
  const pod = obj.metadata.name;
  return (
    <Section title="Debug containers" count={debugContainers.length}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Ephemeral containers cannot be removed from the pod; stopped ones stay listed until the pod is recreated.
      </Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Image</TableCell>
            <TableCell>Target</TableCell>
            <TableCell>State</TableCell>
            <TableCell>Started</TableCell>
            <TableCell align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {debugContainers.map((c) => (
            <TableRow key={c.name}>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{c.name}</TableCell>
              <TableCell title={c.image}>
                <Box sx={{ maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.image}</Box>
              </TableCell>
              <TableCell>{c.target ?? ''}</TableCell>
              <TableCell>
                <StatusChip status={c.state === 'running' ? 'Running' : c.state === 'terminated' ? 'Completed' : c.state} />
              </TableCell>
              <TableCell>{c.startedAt ? <AgeCell timestamp={c.startedAt} /> : ''}</TableCell>
              <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                {c.state === 'running' && (
                  <>
                    <Button
                      size="small"
                      startIcon={<TerminalIcon />}
                      onClick={() =>
                        addTab({ kind: 'terminal', id: dockTabId(), title: `debug: ${pod}`, ctx, namespace, pod, container: c.name })
                      }
                    >
                      Shell
                    </Button>
                    <Button
                      size="small"
                      color="warning"
                      startIcon={<StopCircleOutlinedIcon />}
                      disabled={stop.isPending}
                      onClick={() =>
                        stop.mutate(
                          { ctx, body: { namespace, pod, container: c.name } },
                          {
                            onSuccess: () => showToast('success', `Stopping ${c.name} — it exits within a second`),
                            onError: (e) => showToast('error', e instanceof Error ? e.message : String(e)),
                          },
                        )
                      }
                    >
                      Stop
                    </Button>
                  </>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

type RefOpener = (kind: RelatedKind, name: string) => void;

const PROBE_KINDS = [
  ['readiness', 'readinessProbe'],
  ['liveness', 'livenessProbe'],
  ['startup', 'startupProbe'],
] as const;

function probeTarget(p: Probe): string {
  if (p.httpGet) return `${(p.httpGet.scheme ?? 'HTTP') === 'HTTPS' ? 'HTTPS' : 'HTTP'} ${p.httpGet.path ?? '/'} :${p.httpGet.port ?? ''}`;
  if (p.tcpSocket) return `TCP :${p.tcpSocket.port ?? ''}`;
  if (p.grpc) return `gRPC :${p.grpc.port ?? ''}${p.grpc.service ? ` ${p.grpc.service}` : ''}`;
  if (p.exec) return `exec ${(p.exec.command ?? []).join(' ')}`;
  return '';
}

function probeTiming(p: Probe): string {
  return `delay ${p.initialDelaySeconds ?? 0}s · period ${p.periodSeconds ?? 10}s · timeout ${p.timeoutSeconds ?? 1}s · fail ${p.failureThreshold ?? 3}×`;
}

function ProbesSection({ spec, statusByName, terminal }: { spec: PodSpec | undefined; statusByName: Map<string, ContainerStatus>; terminal: boolean }) {
  const rows: Array<{ container: string; kind: string; target: string; timing: string; state?: string }> = [];
  for (const c of [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])]) {
    const st = statusByName.get(c.name);
    for (const [label, key] of PROBE_KINDS) {
      const probe = c[key];
      if (!probe) continue;
      // Live probe outcome where the API surfaces one: readiness → `ready`,
      // startup → `started`. Liveness failures only show up as restarts.
      // Finished pods are expectedly NotReady, so no state is shown there.
      const state = terminal
        ? undefined
        : label === 'readiness' && st
          ? st.ready
            ? 'Ready'
            : 'NotReady'
          : label === 'startup' && st
            ? st.started
              ? 'Started'
              : 'Pending'
            : undefined;
      rows.push({ container: c.name, kind: label, target: probeTarget(probe), timing: probeTiming(probe), state });
    }
  }
  if (!rows.length) return null;
  return (
    <Section title="Probes" count={rows.length}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Container</TableCell>
            <TableCell>Probe</TableCell>
            <TableCell>Target</TableCell>
            <TableCell>Timing</TableCell>
            <TableCell>State</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.container}:${r.kind}`}>
              <TableCell sx={{ wordBreak: 'break-word' }}>{r.container}</TableCell>
              <TableCell>{r.kind}</TableCell>
              {/* Target gets the width priority — nowrap on Timing would starve
                  it into breaking URLs mid-token. */}
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-word', minWidth: 170 }}>{r.target}</TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">
                  {r.timing}
                </Typography>
              </TableCell>
              <TableCell>{r.state ? <StatusChip status={r.state} /> : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function envSourceLabel(env: PodEnvVar): { text: string; refKind?: 'ConfigMap' | 'Secret'; refName?: string } {
  const s = env.source;
  if (!s || s.type === 'literal') return { text: '' };
  if (s.type === 'fieldRef') return { text: `field ${s.key ?? ''}` };
  if (s.type === 'resourceFieldRef') return { text: `resource ${s.key ?? ''}` };
  const isSecret = s.type === 'secretKeyRef' || s.type === 'secretRef';
  const base = `${isSecret ? 'secret' : 'configmap'}/${s.ref ?? ''}`;
  // The key only earns space when it differs from the variable name.
  const showKey = s.key && s.key !== env.name && s.type !== 'configMapRef' && s.type !== 'secretRef';
  return { text: showKey ? `${base} → ${s.key}` : base, refKind: isSecret ? 'Secret' : 'ConfigMap', refName: s.ref };
}

function EnvSection({ ctx, namespace, pod, onOpenRef }: { ctx: string; namespace: string; pod: string; onOpenRef: RefOpener }) {
  const [reveal, setReveal] = useState(false);
  const { data, isLoading } = usePodEnv({ ctx, namespace, name: pod, reveal });
  const containers = (data?.containers ?? []).filter((c) => c.env.length > 0);
  const hasSecrets = containers.some((c) => c.env.some((e) => e.redacted));
  if (!isLoading && containers.length === 0) return null;

  return (
    <Section
      title="Environment"
      actions={
        hasSecrets ? (
          <FormControlLabel
            control={<Switch size="small" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />}
            label={<Typography variant="caption">Reveal secret values</Typography>}
          />
        ) : undefined
      }
    >
      {isLoading && <CircularProgress size={18} />}
      {containers.map((c) => {
        // Kubernetes resolves duplicates last-wins (env overrides envFrom,
        // later envFrom sources override earlier ones) — mark shadowed rows.
        const lastIndexByName = new Map<string, number>();
        c.env.forEach((env, i) => lastIndexByName.set(env.name, i));
        return (
          <Box key={`${c.init ? 'i' : 'c'}:${c.name}`} sx={{ mb: 1.5 }}>
            {containers.length > 1 && (
              <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, mb: 0.25 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {c.name}
                </Typography>
                {c.init && <Chip label="init" sx={{ height: 16, fontSize: 10 }} />}
                <Typography variant="caption" color="text.secondary">
                  {c.env.length}
                </Typography>
              </Stack>
            )}
            <Table size="small">
              <TableBody>
                {c.env.map((env, i) => {
                  const source = envSourceLabel(env);
                  const overridden = lastIndexByName.get(env.name) !== i;
                  const hidden = !!env.redacted && !reveal;
                  const copyable = !env.error && !hidden && !!env.value;
                  return (
                    <TableRow
                      key={`${env.name}:${i}`}
                      sx={{ '& .kubus-env-copy': { opacity: 0, transition: 'opacity 120ms' }, '&:hover .kubus-env-copy': { opacity: 1 } }}
                    >
                      <TableCell
                        sx={{
                          width: '1%',
                          pr: 1,
                          verticalAlign: 'top',
                          fontFamily: 'monospace',
                          fontSize: 12,
                          ...(overridden && { color: 'text.disabled', textDecoration: 'line-through' }),
                        }}
                        title={env.name}
                      >
                        <Box sx={{ maxWidth: 240, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {overridden ? (
                            <Tooltip title="Shadowed — a later entry with the same name wins.">
                              <span>{env.name}</span>
                            </Tooltip>
                          ) : (
                            env.name
                          )}
                        </Box>
                      </TableCell>
                      <TableCell
                        sx={{
                          px: 1,
                          verticalAlign: 'top',
                          fontFamily: 'monospace',
                          fontSize: 12,
                          wordBreak: 'break-word',
                          position: 'relative',
                          ...(overridden && { color: 'text.disabled' }),
                          ...(hidden && { color: 'text.secondary', letterSpacing: 1 }),
                        }}
                      >
                        {env.error ? (
                          <Typography component="span" variant="caption" sx={{ color: statusTextColor('warning') }}>
                            {env.error}
                          </Typography>
                        ) : (
                          (env.value ?? '')
                        )}
                        {copyable && (
                          <Box
                            className="kubus-env-copy"
                            sx={{ position: 'absolute', top: 2, right: 0, bgcolor: 'background.paper', borderRadius: 1, boxShadow: 1 }}
                          >
                            <CopyValueButton text={env.value!} label={`Copy value of ${env.name}`} />
                          </Box>
                        )}
                      </TableCell>
                      <TableCell align="right" sx={{ pl: 1, verticalAlign: 'top' }} title={source.text || undefined}>
                        <Box sx={{ maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ml: 'auto' }}>
                          {source.refKind && source.refName ? (
                            <Link component="button" variant="caption" color="text.secondary" onClick={() => onOpenRef(source.refKind!, source.refName!)}>
                              {source.text}
                            </Link>
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              {source.text}
                            </Typography>
                          )}
                        </Box>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        );
      })}
    </Section>
  );
}

/** Human label + navigable reference for a pod volume. */
function volumeInfo(v: VolumeSpec): { type: string; detail?: string; refKind?: 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim'; refName?: string } {
  if (v.persistentVolumeClaim) {
    const claim = (v.persistentVolumeClaim as { claimName?: string }).claimName;
    return { type: 'persistentVolumeClaim', detail: claim, refKind: 'PersistentVolumeClaim', refName: claim };
  }
  if (v.configMap) {
    const name = (v.configMap as { name?: string }).name;
    return { type: 'configMap', detail: name, refKind: 'ConfigMap', refName: name };
  }
  if (v.secret) {
    const name = (v.secret as { secretName?: string }).secretName;
    return { type: 'secret', detail: name, refKind: 'Secret', refName: name };
  }
  if (v.hostPath) return { type: 'hostPath', detail: (v.hostPath as { path?: string }).path };
  if (v.image) {
    const img = v.image as { reference?: string; pullPolicy?: string };
    return { type: 'image', detail: `${img.reference ?? ''}${img.pullPolicy ? ` (${img.pullPolicy})` : ''}` };
  }
  const type = Object.keys(v).find((k) => k !== 'name') ?? 'unknown';
  return { type };
}

function VolumesSection({ spec, onOpenRef }: { spec: PodSpec | undefined; onOpenRef: RefOpener }) {
  const volumes = spec?.volumes ?? [];
  if (!volumes.length) return null;
  const allContainers = [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])];
  // The container prefix is only informative when there is more than one.
  const showContainer = allContainers.length > 1;
  const mountsByVolume = new Map<string, Array<{ container: string; path: string; note?: string }>>();
  for (const c of allContainers) {
    for (const m of c.volumeMounts ?? []) {
      const note = [m.subPath ? `subPath ${m.subPath}` : undefined, m.readOnly ? 'ro' : undefined].filter(Boolean).join(', ');
      const entry = { container: c.name, path: m.mountPath, note: note || undefined };
      mountsByVolume.set(m.name, [...(mountsByVolume.get(m.name) ?? []), entry]);
    }
  }
  return (
    <Section title="Volumes" count={volumes.length}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Source</TableCell>
            <TableCell>Mounted at</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {volumes.map((v) => {
            const info = volumeInfo(v);
            return (
              <TableRow key={v.name}>
                <TableCell sx={{ verticalAlign: 'top', wordBreak: 'break-word' }}>{v.name}</TableCell>
                <TableCell sx={{ verticalAlign: 'top' }}>
                  {info.refKind && info.refName ? (
                    <Link component="button" variant="body2" sx={{ textAlign: 'left' }} onClick={() => onOpenRef(info.refKind!, info.refName!)}>
                      {info.type}/{info.detail}
                    </Link>
                  ) : (
                    `${info.type}${info.detail ? `/${info.detail}` : ''}`
                  )}
                </TableCell>
                <TableCell sx={{ verticalAlign: 'top', wordBreak: 'break-word' }}>
                  {(mountsByVolume.get(v.name) ?? []).map((m, i) => (
                    <Typography key={i} variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {showContainer && (
                        <Box component="span" sx={{ color: 'text.secondary' }}>
                          {m.container}:{' '}
                        </Box>
                      )}
                      {m.path}
                      {m.note && (
                        <Box component="span" sx={{ color: 'text.secondary' }}>
                          {` (${m.note})`}
                        </Box>
                      )}
                    </Typography>
                  ))}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}

function SchedulingSection({ spec }: { spec: PodSpec | undefined }) {
  const tolerations = spec?.tolerations ?? [];
  const nodeSelector = spec?.nodeSelector ?? {};
  if (!tolerations.length && !Object.keys(nodeSelector).length) return null;
  return (
    <Section title="Scheduling">
      <Stack spacing={1.5}>
        <KeyValueChips title="Node selector" entries={Object.keys(nodeSelector).length ? nodeSelector : undefined} />
        {tolerations.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Toleration key</TableCell>
                <TableCell>Operator</TableCell>
                <TableCell>Value</TableCell>
                <TableCell>Effect</TableCell>
                <TableCell>Seconds</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tolerations.map((t, i) => (
                <TableRow key={i}>
                  <TableCell>{t.key ?? '(all)'}</TableCell>
                  <TableCell>{t.operator ?? 'Equal'}</TableCell>
                  <TableCell>{t.value ?? ''}</TableCell>
                  <TableCell>{t.effect ?? '(all)'}</TableCell>
                  <TableCell>{t.tolerationSeconds ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Stack>
    </Section>
  );
}
