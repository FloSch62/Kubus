import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { NetworkAgentInstallResult, NetworkAgentStatus, NetworkAgentUninstallResult } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { loadAllYaml } from '../util/yaml.js';
import { HttpProblem } from '../util/errors.js';
import { RETINA_MANIFEST_YAML } from './network-agent-manifest.js';

export const NETWORK_AGENT_VERSION = 'v1.2.3';
export const NETWORK_AGENT_NAMESPACE = 'kube-system';
export const NETWORK_AGENT_PORT = 10093;
export const NETWORK_AGENT_SELECTOR = 'app.kubernetes.io/name=retina';

const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
const MANAGED_BY_VALUE = 'kubus';
const DAEMONSET_PATH = resourcePath('apps', 'v1', 'daemonsets', { namespace: NETWORK_AGENT_NAMESPACE, name: 'retina-agent' });
const METRICS_CONFIG_NAME = 'kubus-network-metrics';
export const METRICS_CONFIG_PATH = `/apis/retina.sh/v1alpha1/metricsconfigurations/${METRICS_CONFIG_NAME}`;

/** Resource paths per manifest kind — the manifest is vendored, so this stays in lockstep. */
const KIND_PATHS: Record<string, { group: string; version: string; plural: string; namespaced: boolean }> = {
  CustomResourceDefinition: { group: 'apiextensions.k8s.io', version: 'v1', plural: 'customresourcedefinitions', namespaced: false },
  ServiceAccount: { group: '', version: 'v1', plural: 'serviceaccounts', namespaced: true },
  ConfigMap: { group: '', version: 'v1', plural: 'configmaps', namespaced: true },
  ClusterRole: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterroles', namespaced: false },
  ClusterRoleBinding: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterrolebindings', namespaced: false },
  DaemonSet: { group: 'apps', version: 'v1', plural: 'daemonsets', namespaced: true },
  Deployment: { group: 'apps', version: 'v1', plural: 'deployments', namespaced: true },
};

interface ManifestDoc {
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  [key: string]: unknown;
}

function manifestDocs(): ManifestDoc[] {
  const docs = loadAllYaml(RETINA_MANIFEST_YAML) as ManifestDoc[];
  for (const doc of docs) {
    doc.metadata.labels = { ...doc.metadata.labels, [MANAGED_BY_LABEL]: MANAGED_BY_VALUE };
  }
  return docs;
}

function docPath(doc: ManifestDoc): { path: string; label: string } {
  const target = KIND_PATHS[doc.kind];
  if (!target) throw new HttpProblem(500, `unexpected kind in network-agent manifest: ${doc.kind}`);
  const namespace = target.namespaced ? (doc.metadata.namespace ?? NETWORK_AGENT_NAMESPACE) : undefined;
  return {
    path: resourcePath(target.group, target.version, target.plural, { namespace, name: doc.metadata.name }),
    label: `${doc.kind}/${namespace ? `${namespace}/` : ''}${doc.metadata.name}`,
  };
}

/**
 * The MetricsConfiguration CR that turns on Retina's pod-level (adv_)
 * metrics. Its namespace include-list must be explicit — a "*" entry is
 * matched literally and silently disables everything — so Kubus generates it
 * from the live namespace set and the network poller re-applies it whenever
 * namespaces drift. tcp_retransmission_count / drop_bytes series only appear
 * once such events occur.
 */
export function buildMetricsConfiguration(namespaces: string[]): Record<string, unknown> {
  const contextOption = (metricName: string) => ({
    metricName,
    sourceLabels: ['ip', 'namespace', 'podname'],
    destinationLabels: ['ip', 'namespace', 'podname'],
    additionalLabels: ['direction'],
  });
  return {
    apiVersion: 'retina.sh/v1alpha1',
    kind: 'MetricsConfiguration',
    metadata: { name: METRICS_CONFIG_NAME, labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE } },
    spec: {
      contextOptions: ['forward_bytes', 'forward_count', 'drop_bytes', 'tcp_retransmission_count'].map(contextOption),
      namespaces: { include: [...namespaces].sort() },
    },
  };
}

async function ssa(handle: ClusterHandle, path: string, body: Record<string, unknown>): Promise<void> {
  await handle.raw.json(`${path}?fieldManager=kubus&force=true`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/apply-patch+yaml' },
    body: JSON.stringify(body),
  });
}

async function liveNamespaces(handle: ClusterHandle): Promise<string[]> {
  const cached = handle.watchers.peek('', 'v1', 'namespaces')?.items() ?? [];
  if (cached.length) return cached.map((ns) => ns.metadata.name);
  const list = await handle.raw.json<{ items?: Array<{ metadata?: { name?: string } }> }>('/api/v1/namespaces');
  return (list.items ?? []).flatMap((ns) => (ns.metadata?.name ? [ns.metadata.name] : []));
}

/**
 * Apply the current MetricsConfiguration. Exposed for the network poller,
 * which re-applies it when the namespace set changes.
 */
export async function applyMetricsConfiguration(handle: ClusterHandle, namespaces: string[]): Promise<void> {
  await ssa(handle, METRICS_CONFIG_PATH, buildMetricsConfiguration(namespaces));
}

/**
 * Install (or repair) Retina via server-side apply of the vendored upstream
 * manifest — idempotent, no helm involved. Fails fast on the first resource
 * the user lacks permissions for. The MetricsConfiguration CR is applied
 * last, retrying briefly while its just-created CRD becomes established.
 */
export async function installNetworkAgent(handle: ClusterHandle): Promise<NetworkAgentInstallResult> {
  const applied: string[] = [];
  for (const doc of manifestDocs()) {
    const { path, label } = docPath(doc);
    await ssa(handle, path, doc);
    applied.push(label);
  }
  const namespaces = await liveNamespaces(handle);
  for (let attempt = 0; ; attempt++) {
    try {
      await applyMetricsConfiguration(handle, namespaces);
      break;
    } catch (err) {
      if (attempt >= 5 || (err as { code?: number }).code !== 404) throw err;
      await delay(2_000); // CRD not established yet
    }
  }
  applied.push(`MetricsConfiguration/${METRICS_CONFIG_NAME}`);
  handle.networkPoller.kick();
  return { applied };
}

/**
 * Delete the MetricsConfiguration CR and every resource of the vendored
 * manifest (reverse order, best-effort). All names are upstream's, so this
 * also removes a standard Retina install.
 */
export async function uninstallNetworkAgent(handle: ClusterHandle, log: FastifyBaseLogger): Promise<NetworkAgentUninstallResult> {
  const result: NetworkAgentUninstallResult = { deleted: [], failed: [] };
  const targets = [
    { path: METRICS_CONFIG_PATH, label: `MetricsConfiguration/${METRICS_CONFIG_NAME}` },
    ...manifestDocs().reverse().map(docPath),
  ];
  for (const { path, label } of targets) {
    try {
      await handle.raw.json(path, { method: 'DELETE' });
      result.deleted.push(label);
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        result.deleted.push(label);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ label, err: message }, 'network-agent uninstall: resource delete failed');
        result.failed.push({ resource: label, error: message });
      }
    }
  }
  // Flip to unavailable immediately — agent pods linger while terminating,
  // so probing now (kick) would report stale availability.
  handle.networkPoller.markUnavailable();
  return result;
}

interface DaemonSetProbe {
  metadata?: { labels?: Record<string, string> };
  spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } };
  status?: { numberReady?: number; desiredNumberScheduled?: number };
}

export async function networkAgentStatus(handle: ClusterHandle): Promise<NetworkAgentStatus> {
  let daemonSet: DaemonSetProbe | undefined;
  try {
    daemonSet = await handle.raw.json<DaemonSetProbe>(DAEMONSET_PATH);
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
  }
  const installed = !!daemonSet;
  const image = daemonSet?.spec?.template?.spec?.containers?.find((c) => c.name === 'retina')?.image;
  const tag = image?.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : undefined;
  const nodesReady = daemonSet?.status?.numberReady ?? 0;
  // Freshly installed but not yet polled: probe promptly so the UI flips to
  // "available" within seconds instead of the slow unavailable interval.
  if (nodesReady > 0 && !handle.networkPoller.available) handle.networkPoller.kick();
  return {
    installed,
    managedByKubus: daemonSet?.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE,
    ready: nodesReady > 0,
    version: tag,
    nodesReady,
    nodesDesired: daemonSet?.status?.desiredNumberScheduled ?? 0,
    metricsAvailable: handle.networkPoller.available,
  };
}
