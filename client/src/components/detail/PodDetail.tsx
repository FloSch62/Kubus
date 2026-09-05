import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import TerminalIcon from '@mui/icons-material/Terminal';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import type { ContainerUsage, KubeObject, PodEnvVar } from '@kubus/shared';
import { gvkForKind } from '@kubus/shared';
import { ConditionsTable, KeyValueChips, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { Fact, FactLink, Facts } from './Facts.js';
import { PortForwardDialog } from '../PortForwardDialog.js';
import { PodProblems } from './PodProblems.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';
import { ContainerPanels, type ContainerPanelData } from './ContainerPanels.js';
import { containerState, mountRows, probeRows, volumeInfo, type ContainerSpec, type ContainerStatus, type VolumeSpec } from './container-spec.js';
import { StatusChip } from '../StatusChip.js';
import { AgeCell } from '../AgeCell.js';
import { containerResources, ownerReference, podContainerNames, podDebugContainers, podSummary } from '../../kube-display.js';
import { usePodEnv, useResourceMetrics, useStopDebug } from '../../api/queries.js';
import { useDetailStore } from '../../state/detail.js';
import { showToast } from '../../state/toast.js';
import { useDockStore, dockTabId } from '../../state/dock.js';
import { UsedBySection } from './UsedBySection.js';

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
  affinity?: Record<string, unknown>;
  priorityClassName?: string;
  priority?: number;
  restartPolicy?: string;
  dnsPolicy?: string;
  hostNetwork?: boolean;
  terminationGracePeriodSeconds?: number;
  runtimeClassName?: string;
}

interface PodStatus {
  phase?: string;
  podIP?: string;
  podIPs?: Array<{ ip: string }>;
  hostIP?: string;
  containerStatuses?: ContainerStatus[];
  initContainerStatuses?: ContainerStatus[];
  qosClass?: string;
  startTime?: string;
}

type RelatedKind = 'Node' | 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim' | 'ServiceAccount';

const SELECTOR_KINDS = ['Service', 'PodDisruptionBudget', 'NetworkPolicy'];

function panelData(
  c: ContainerSpec,
  st: ContainerStatus | undefined,
  usage: ContainerUsage | undefined,
  volumes: VolumeSpec[] | undefined,
  live: boolean,
  env: PodEnvVar[] | undefined,
  envLoading: boolean,
  kind?: 'init' | 'sidecar',
): ContainerPanelData {
  const state = containerState(st);
  const last = st?.lastState?.terminated;
  return {
    name: c.name,
    image: c.image,
    kind,
    state: state.state,
    stateMessage: state.message,
    ready: st?.ready,
    shellable: state.shellable,
    restarts: st?.restartCount,
    lastRestart: last ? { reason: last.reason, at: last.finishedAt, exitCode: last.exitCode } : undefined,
    ports: (c.ports ?? []).map((p) => ({ port: p.containerPort, protocol: p.protocol, name: p.name })),
    resources: containerResources(c),
    usage: usage ? { cpuMilli: usage.cpuMilli, memBytes: usage.memBytes } : undefined,
    probes: probeRows(c, st, live),
    mounts: mountRows(c, volumes),
    env,
    envLoading,
    command: c.command,
    args: c.args,
    imagePullPolicy: c.imagePullPolicy,
    workingDir: c.workingDir,
  };
}

export function PodDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const spec = obj.spec as PodSpec | undefined;
  const status = obj.status as PodStatus | undefined;
  // Conditions and probe outcomes on finished pods are stale (Ready=False is
  // expected there), and there is no process left to shell into.
  const terminal = status?.phase === 'Succeeded' || status?.phase === 'Failed';
  const summary = podSummary(obj);
  const statusByName = new Map((status?.containerStatuses ?? []).map((c) => [c.name, c]));
  const initStatusByName = new Map((status?.initContainerStatuses ?? []).map((c) => [c.name, c]));
  const push = useDetailStore((s) => s.push);
  const namespace = obj.metadata.namespace;
  const [forwardPort, setForwardPort] = useState<number>();
  const [reveal, setReveal] = useState(false);

  const metricsQuery = useResourceMetrics([ctx], 'pods');
  const usageByContainer = useMemo(() => {
    const snap = metricsQuery.data?.get(ctx);
    if (!snap?.available) return new Map<string, ContainerUsage>();
    const entry = snap.items.find((i) => i.namespace === namespace && i.name === obj.metadata.name);
    return new Map((entry?.containers ?? []).map((c) => [c.name, c]));
  }, [metricsQuery.data, ctx, namespace, obj.metadata.name]);

  // One env fetch for the pod, handed to each container's panel.
  const envQuery = usePodEnv(namespace ? { ctx, namespace, name: obj.metadata.name, reveal } : undefined);
  const envByContainer = useMemo(() => new Map((envQuery.data?.containers ?? []).map((c) => [c.name, c.env])), [envQuery.data]);
  const envLoading = !!namespace && envQuery.isLoading;

  const openRelated = (kind: RelatedKind, name: string) => {
    const gvk = gvkForKind(kind);
    if (!gvk) return;
    push({ ctx, group: gvk.group, version: gvk.version, plural: gvk.plural, kind, name, namespace: gvk.namespaced ? namespace : undefined });
  };
  const owner = ownerReference(obj);
  const ownerGvk = owner ? gvkForKind(owner.kind) : undefined;

  // Per-container logs/shell: the pod-level actions cover every container at
  // once, so these exist to isolate one of a multi-container pod.
  const addTab = useDockStore((s) => s.addTab);
  const openContainerLogs = (container: string) =>
    addTab({
      kind: 'logs',
      id: dockTabId(),
      title: `logs: ${obj.metadata.name}/${container}`,
      ctx,
      namespace: namespace ?? '',
      pods: [obj.metadata.name],
      sources: [{ pod: obj.metadata.name, containers: podContainerNames(obj) }],
      container,
      follow: true,
    });
  const openContainerShell = (container: string) =>
    addTab({ kind: 'terminal', id: dockTabId(), title: `sh: ${obj.metadata.name}/${container}`, ctx, namespace: namespace ?? '', pod: obj.metadata.name, container });

  // Restartable init containers are sidecars: they run alongside the app
  // containers, so they list with them; one-shot inits get their own section.
  const sidecars = (spec?.initContainers ?? []).filter((c) => c.restartPolicy === 'Always');
  const inits = (spec?.initContainers ?? []).filter((c) => c.restartPolicy !== 'Always');
  const toPanel = (c: ContainerSpec, st: ContainerStatus | undefined, kind?: 'init' | 'sidecar') =>
    panelData(c, st, usageByContainer.get(c.name), spec?.volumes, !terminal, envByContainer.get(c.name), envLoading, kind);
  const mainPanels = [
    ...(spec?.containers ?? []).map((c) => toPanel(c, statusByName.get(c.name))),
    ...sidecars.map((c) => toPanel(c, initStatusByName.get(c.name), 'sidecar')),
  ];
  const initPanels = inits.map((c) => toPanel(c, initStatusByName.get(c.name), 'init'));
  // Finished inits are history; an init still running or failing is the
  // reason the pod isn't up, so the section opens itself.
  const initsActive = initPanels.some((p) => p.state !== 'Completed');

  const allReady = !summary.ready.startsWith('0/') && summary.ready.split('/')[0] === summary.ready.split('/')[1];
  const readyTone = terminal ? undefined : allReady ? 'success' : 'warning';
  const extraIps = (status?.podIPs ?? []).map((p) => p.ip).filter((ip) => ip !== status?.podIP);

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Ready', value: summary.ready, tone: readyTone },
          { label: 'Restarts', value: String(summary.restarts), tone: summary.restarts > 0 && !allReady && !terminal ? 'warning' : undefined },
          {
            span: 2,
            label: 'Node',
            value: spec?.nodeName ? (
              <Link component="button" underline="hover" title={`Open node ${spec.nodeName}`} onClick={() => openRelated('Node', spec.nodeName!)} sx={{ font: 'inherit', verticalAlign: 'baseline', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {spec.nodeName}
              </Link>
            ) : undefined,
            title: spec?.nodeName,
          },
          { label: 'Pod IP', value: status?.podIP, mono: true },
        ]}
      />
      <PodProblems obj={obj} ctx={ctx} />
      <Section title="Containers" count={mainPanels.length} flush>
        <ContainerPanels
          items={mainPanels}
          onLogs={openContainerLogs}
          onShell={terminal ? undefined : openContainerShell}
          onForwardPort={terminal ? undefined : setForwardPort}
          onOpenRef={openRelated}
          revealSecrets={reveal}
          onRevealSecrets={setReveal}
        />
      </Section>
      {initPanels.length > 0 && (
        <Section title="Init containers" count={initPanels.length} flush defaultOpen={initsActive} description={initsActive ? undefined : 'all completed'}>
          <ContainerPanels items={initPanels} onLogs={openContainerLogs} onOpenRef={openRelated} revealSecrets={reveal} onRevealSecrets={setReveal} />
        </Section>
      )}
      <DebugContainersSection obj={obj} ctx={ctx} />
      <Section title="Details">
        <Facts>
          <Fact label="Host IP" mono>
            {status?.hostIP}
          </Fact>
          <Fact label="Other IPs" mono>
            {extraIps.join(', ')}
          </Fact>
          <Fact label="Service account">
            {spec?.serviceAccountName && (
              <FactLink title={`Open ServiceAccount ${spec.serviceAccountName}`} onClick={() => openRelated('ServiceAccount', spec.serviceAccountName!)}>
                {spec.serviceAccountName}
              </FactLink>
            )}
          </Fact>
          <Fact label="Controlled by">
            {owner &&
              (ownerGvk ? (
                <FactLink
                  title={`Open ${owner.kind} ${owner.name}`}
                  onClick={() =>
                    push({
                      ctx,
                      group: ownerGvk.group,
                      version: ownerGvk.version,
                      plural: ownerGvk.plural,
                      kind: owner.kind,
                      name: owner.name,
                      namespace: ownerGvk.namespaced ? namespace : undefined,
                    })
                  }
                >
                  {owner.kind}/{owner.name}
                </FactLink>
              ) : (
                `${owner.kind}/${owner.name}`
              ))}
          </Fact>
          <Fact label="Started">
            {status?.startTime && (
              <>
                <AgeCell timestamp={status.startTime} /> ago
              </>
            )}
          </Fact>
          <Fact label="QoS class" hint="Guaranteed: all containers have limits = requests. Burstable: some requests set. BestEffort: none.">
            {status?.qosClass}
          </Fact>
          <Fact label="Priority">
            {spec?.priorityClassName
              ? `${spec.priorityClassName}${spec.priority !== undefined ? ` (${spec.priority})` : ''}`
              : spec?.priority
                ? String(spec.priority)
                : undefined}
          </Fact>
          <Fact label="Restart policy">{spec?.restartPolicy}</Fact>
          <Fact label="DNS policy">{spec?.dnsPolicy}</Fact>
          <Fact label="Host network">{spec?.hostNetwork ? 'Yes' : undefined}</Fact>
          <Fact label="Runtime class">{spec?.runtimeClassName}</Fact>
          <Fact label="Grace period">{spec?.terminationGracePeriodSeconds !== undefined ? `${spec.terminationGracePeriodSeconds}s` : undefined}</Fact>
        </Facts>
      </Section>
      <VolumesSection spec={spec} onOpenRef={openRelated} />
      {!terminal && (
        <UsedBySection
          target={{ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: obj.metadata.name, namespace }}
          title="Selected by"
          kinds={SELECTOR_KINDS}
          emptyText="No Service, PodDisruptionBudget or NetworkPolicy selects this pod."
          defaultOpen={false}
        />
      )}
      <SchedulingSection spec={spec} />
      {!terminal && <ConditionsTable obj={obj} defaultOpen={false} />}
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
      {forwardPort !== undefined && (
        <PortForwardDialog ctx={ctx} kind="Pod" obj={obj} initialRemotePort={forwardPort} onClose={() => setForwardPort(undefined)} />
      )}
    </DetailStack>
  );
}

function DebugContainersSection({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const debugContainers = podDebugContainers(obj);
  const stop = useStopDebug();
  const addTab = useDockStore((s) => s.addTab);
  if (!debugContainers.length) return null;
  const namespace = obj.metadata.namespace ?? '';
  const pod = obj.metadata.name;
  const running = debugContainers.filter((c) => c.state === 'running').length;
  return (
    <Section title="Debug containers" count={debugContainers.length} flush description={running ? `${running} running` : 'none running'}>
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
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{c.image}</TableCell>
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
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1 }}>
        Ephemeral containers cannot be removed from the pod; stopped ones stay listed until the pod is recreated.
      </Typography>
    </Section>
  );
}

type RefOpener = (kind: RelatedKind, name: string) => void;

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
    <Section title="Volumes" count={volumes.length} flush>
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
  const affinityKinds = Object.keys(spec?.affinity ?? {});
  if (!tolerations.length && !Object.keys(nodeSelector).length && !affinityKinds.length) return null;
  const parts = [
    Object.keys(nodeSelector).length ? 'node selector' : undefined,
    affinityKinds.length ? 'affinity' : undefined,
    tolerations.length ? `${tolerations.length} toleration${tolerations.length === 1 ? '' : 's'}` : undefined,
  ].filter(Boolean);
  return (
    <Section title="Scheduling" flush description={parts.join(' · ')}>
      {(Object.keys(nodeSelector).length > 0 || affinityKinds.length > 0) && (
        <Stack spacing={1.5} sx={{ p: 1.5 }}>
          <KeyValueChips title="Node selector" entries={Object.keys(nodeSelector).length ? nodeSelector : undefined} />
          {affinityKinds.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.25 }}>
                Affinity
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {affinityKinds.join(', ')} — see the Manifest tab for the rules.
              </Typography>
            </Box>
          )}
        </Stack>
      )}
      {tolerations.length > 0 && (
        <Table size="small" sx={{ borderTop: Object.keys(nodeSelector).length || affinityKinds.length ? '1px solid' : 0, borderColor: 'divider' }}>
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
                <TableCell sx={{ wordBreak: 'break-word' }}>{t.key ?? '(all)'}</TableCell>
                <TableCell>{t.operator ?? 'Equal'}</TableCell>
                <TableCell>{t.value ?? ''}</TableCell>
                <TableCell>{t.effect ?? '(all)'}</TableCell>
                <TableCell>{t.tolerationSeconds ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

