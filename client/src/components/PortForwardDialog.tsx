import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { KubeObject, PortForwardTargetKind } from '@kubus/shared';
import { checkLocalPort, usePortForwardPreflight, useResourceList, useStartPortForward } from '../api/queries.js';
import { forwardPrefKey, usePortForwardPrefsStore } from '../state/portforward-prefs.js';
import { showToast } from '../state/toast.js';

const REQUEST_KINDS: Record<string, PortForwardTargetKind> = {
  Pod: 'pod',
  Service: 'service',
  Deployment: 'deployment',
  StatefulSet: 'statefulset',
  DaemonSet: 'daemonset',
  ReplicaSet: 'replicaset',
};

export function isForwardableKind(kind: string | undefined): boolean {
  return !!kind && kind in REQUEST_KINDS;
}

interface PortOption {
  port: number;
  label: string;
}

interface ContainerWithPorts {
  name: string;
  ports?: Array<{ containerPort: number; name?: string; protocol?: string }>;
}

function containerPortOptions(containers: ContainerWithPorts[]): PortOption[] {
  const seen = new Set<number>();
  const options: PortOption[] = [];
  for (const c of containers) {
    for (const p of c.ports ?? []) {
      if ((p.protocol ?? 'TCP') !== 'TCP' || seen.has(p.containerPort)) continue;
      seen.add(p.containerPort);
      options.push({ port: p.containerPort, label: `${p.containerPort}${p.name ? ` · ${p.name}` : ''} (${c.name})` });
    }
  }
  return options;
}

/** Known TCP ports of the target, shown as suggestions in the dialog. */
function portOptions(kind: string, obj: KubeObject): PortOption[] {
  if (kind === 'Service') {
    const ports = (obj.spec as { ports?: Array<{ name?: string; port: number; targetPort?: number | string; protocol?: string }> } | undefined)?.ports ?? [];
    return ports
      .filter((p) => (p.protocol ?? 'TCP') === 'TCP')
      .map((p) => ({
        port: p.port,
        label: `${p.port}${p.name ? ` · ${p.name}` : ''}${p.targetPort !== undefined && p.targetPort !== p.port ? ` → ${p.targetPort}` : ''}`,
      }));
  }
  if (kind === 'Pod') {
    const spec = obj.spec as { containers?: ContainerWithPorts[]; initContainers?: ContainerWithPorts[] } | undefined;
    return containerPortOptions([...(spec?.containers ?? []), ...(spec?.initContainers ?? [])]);
  }
  const template = (obj.spec as { template?: { spec?: { containers?: ContainerWithPorts[] } } } | undefined)?.template?.spec;
  return containerPortOptions(template?.containers ?? []);
}

interface PodLikeSpec {
  containers?: ContainerWithPorts[];
  selector?: { matchLabels?: Record<string, string> };
  template?: { metadata?: { labels?: Record<string, string> }; spec?: { containers?: ContainerWithPorts[] } };
}

/**
 * Ports discovered via Services selecting this pod/workload. Charts often omit
 * containerPort declarations, leaving the Service targetPort as the only
 * record of what the pod actually listens on.
 */
function serviceDerivedOptions(kind: string, obj: KubeObject, services: KubeObject[] | undefined): PortOption[] {
  if (kind === 'Service' || !services?.length) return [];
  const spec = obj.spec as PodLikeSpec | undefined;
  const labels = kind === 'Pod' ? obj.metadata.labels : (spec?.template?.metadata?.labels ?? spec?.selector?.matchLabels);
  if (!labels) return [];
  const containers = kind === 'Pod' ? (spec?.containers ?? []) : (spec?.template?.spec?.containers ?? []);
  const options: PortOption[] = [];
  const seen = new Set<number>();
  for (const svc of services) {
    const svcSpec = svc.spec as
      | { selector?: Record<string, string>; ports?: Array<{ name?: string; port: number; targetPort?: number | string; protocol?: string }> }
      | undefined;
    const selector = Object.entries(svcSpec?.selector ?? {});
    if (!selector.length || !selector.every(([k, v]) => labels[k] === v)) continue;
    for (const p of svcSpec?.ports ?? []) {
      if ((p.protocol ?? 'TCP') !== 'TCP') continue;
      const target = p.targetPort ?? p.port;
      const podPort =
        typeof target === 'number' ? target : containers.flatMap((c) => c.ports ?? []).find((cp) => cp.name === target)?.containerPort;
      if (podPort === undefined || seen.has(podPort)) continue;
      seen.add(podPort);
      options.push({ port: podPort, label: `${podPort}${p.name ? ` · ${p.name}` : ''} (service ${svc.metadata.name})` });
    }
  }
  return options;
}

type LocalPortStatus = 'auto' | 'checking' | 'free' | 'busy' | 'invalid';

function parsePort(text: string): number | undefined {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

export function PortForwardDialog({
  ctx,
  kind,
  obj,
  initialRemotePort,
  onClose,
}: {
  ctx: string;
  /** Kubernetes kind: Pod, Service, Deployment, StatefulSet, DaemonSet or ReplicaSet. */
  kind: string;
  obj: KubeObject;
  /** Pre-select this remote port (inline “forward” buttons beside a port). */
  initialRemotePort?: number;
  onClose: () => void;
}) {
  const start = useStartPortForward();
  const name = obj.metadata.name;
  const namespace = obj.metadata.namespace ?? '';
  const preflight = usePortForwardPreflight(namespace ? { ctx, namespace } : undefined);
  const denied = preflight.data?.allowed === false;

  const remember = usePortForwardPrefsStore((s) => s.remember);
  const prefs = usePortForwardPrefsStore((s) => s.byTarget);
  const prefFor = (port: number) => prefs[forwardPrefKey(ctx, namespace, kind, name, port)];

  const declaredOptions = useMemo(() => portOptions(kind, obj), [kind, obj]);
  // Services selecting this pod/workload fill the gap when the pod template
  // declares no ports (grafana-style charts).
  const servicesQuery = useResourceList(kind !== 'Service' && namespace ? { ctx, group: '', version: 'v1', plural: 'services', namespace } : undefined);
  const options = useMemo(() => {
    const declared = new Set(declaredOptions.map((o) => o.port));
    return [...declaredOptions, ...serviceDerivedOptions(kind, obj, servicesQuery.data?.items).filter((o) => !declared.has(o.port))];
  }, [declaredOptions, kind, obj, servicesQuery.data?.items]);

  // Each field stores only what the user chose; null means "follow the
  // suggestion", so async-arriving options (service-derived ports) flow in
  // without effects and without stomping manual edits.
  const [remoteChoice, setRemoteChoice] = useState<{ text: string; custom: boolean } | null>(
    initialRemotePort !== undefined ? { text: String(initialRemotePort), custom: false } : null,
  );
  const remoteText = remoteChoice?.text ?? String(options[0]?.port ?? 80);
  const customRemote = remoteChoice?.custom || !options.some((o) => String(o.port) === remoteText);
  const remotePort = parsePort(remoteText);

  // Local port suggestion: last remembered for this target+port, else the
  // remote port itself.
  const [localChoice, setLocalChoice] = useState<string | null>(null);
  const localText = localChoice ?? (remotePort !== undefined ? String(prefFor(remotePort)?.localPort ?? remotePort) : '');
  const localPort = parsePort(localText);

  const [browserChoice, setBrowserChoice] = useState<boolean | null>(null);
  const openInBrowser = browserChoice ?? ((remotePort !== undefined && prefFor(remotePort)?.openInBrowser) || false);

  // Advisory availability check for the chosen local port; start() re-checks.
  const [localStatus, setLocalStatus] = useState<LocalPortStatus>('auto');
  const checkSeq = useRef(0);
  useEffect(() => {
    const seq = ++checkSeq.current;
    if (localText === '') {
      setLocalStatus('auto');
      return;
    }
    const port = parsePort(localText);
    if (port === undefined) {
      setLocalStatus('invalid');
      return;
    }
    setLocalStatus('checking');
    const timer = setTimeout(() => {
      checkLocalPort(port)
        .then((r) => {
          if (checkSeq.current === seq) setLocalStatus(r.available ? 'free' : 'busy');
        })
        .catch(() => {
          if (checkSeq.current === seq) setLocalStatus('free');
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [localText]);

  const [startError, setStartError] = useState<string>();

  const localHelper =
    localStatus === 'busy'
      ? `Port ${localText} is already in use on your machine — pick another or leave empty for auto.`
      : localStatus === 'invalid'
        ? 'Enter a port between 1 and 65535, or leave empty.'
        : localStatus === 'auto'
          ? 'Empty — a free port is picked automatically.'
          : ' ';

  const doStart = () => {
    if (remotePort === undefined) return;
    setStartError(undefined);
    start.mutate(
      {
        ctx,
        body: { namespace, kind: REQUEST_KINDS[kind] ?? 'pod', name, remotePort, localPort },
      },
      {
        onSuccess: (info) => {
          // Auto picks are not remembered so a stale random port is never suggested.
          remember(forwardPrefKey(ctx, namespace, kind, name, remotePort), {
            ...(localPort !== undefined ? { localPort } : {}),
            openInBrowser,
          });
          showToast('success', `Forwarding localhost:${info.localPort} → ${name}:${info.remotePort}`);
          if (openInBrowser) window.open(`http://localhost:${info.localPort}`, '_blank', 'noopener');
          onClose();
        },
        onError: (e) => setStartError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Port forward — {kind.toLowerCase()}/{name}
      </DialogTitle>
      <DialogContent sx={{ pt: '12px !important' }}>
        <Stack spacing={2}>
          {denied && (
            <Alert severity="error">
              Your user is not allowed to port-forward in namespace <b>{namespace}</b> on cluster <b>{ctx}</b>
              {preflight.data?.reason ? ` (${preflight.data.reason})` : ''}. Ask a cluster admin for a role granting <b>create</b> on{' '}
              <b>pods/portforward</b>.
            </Alert>
          )}
          {startError && !denied && <Alert severity="error">{startError}</Alert>}
          {options.length > 0 && !customRemote ? (
            <FormControl fullWidth>
              <InputLabel id="pf-remote-port">{kind} port</InputLabel>
              <Select
                labelId="pf-remote-port"
                label={`${kind} port`}
                value={remoteText}
                onChange={(e) => {
                  if (e.target.value === 'custom') setRemoteChoice({ text: remoteText, custom: true });
                  else setRemoteChoice({ text: e.target.value, custom: false });
                }}
              >
                {options.map((o) => (
                  <MenuItem key={o.port} value={String(o.port)}>
                    {o.label}
                  </MenuItem>
                ))}
                <MenuItem value="custom">Custom port…</MenuItem>
              </Select>
            </FormControl>
          ) : (
            <TextField
              fullWidth
              label={`${kind} port`}
              type="number"
              value={remoteText}
              error={remotePort === undefined}
              onChange={(e) => setRemoteChoice({ text: e.target.value, custom: true })}
            />
          )}
          <TextField
            fullWidth
            label="Local port"
            type="number"
            placeholder="auto"
            value={localText}
            error={localStatus === 'busy' || localStatus === 'invalid'}
            helperText={localHelper}
            onChange={(e) => setLocalChoice(e.target.value)}
          />
          <FormControlLabel
            control={
              <Checkbox checked={openInBrowser} onChange={(e) => setBrowserChoice(e.target.checked)} />
            }
            label="Open in browser when started"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={start.isPending || denied || remotePort === undefined || localStatus === 'busy' || localStatus === 'invalid'}
          onClick={doStart}
        >
          {start.isPending ? 'Starting…' : 'Start'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
