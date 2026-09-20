import type { KubeObject, ListResponse, MetricsSnapshot } from '@kubus/shared';
import { apiFetch } from '../api/http.js';
import { podSummary, nodeStatus } from '../kube-display.js';
import { isResourceHealthy } from '../smart-filter.js';
import type { ClusterQuestion } from './cluster-query.js';
import { answerExplorationQuestion } from './explore-answer.js';
import { answerHarnessQuestion } from './harness-answer.js';

export interface QuestionScope { context: string; namespaces: string[] }
export interface AnswerSection { title: string; summary: string; columns: string[]; rows: string[][]; href?: string; rowLinks?: string[]; rowPods?: PodChoice[]; text?: string }
export interface PodChoice { name: string; namespace: string; uid: string }
export interface ClusterAnswer { scope: QuestionScope; question: ClusterQuestion; fetchedAt: string; sections: AnswerSection[]; notices: string[]; candidates?: PodChoice[]; containers?: { pod: PodChoice; name: string }[]; focus?: PodChoice }
type Reader = <T>(path: string, init?: RequestInit) => Promise<T>;
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const identity = (obj: KubeObject) => [obj.metadata.namespace ?? '—', obj.metadata.name];
const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

const RESOURCES = {
  pods: ['core', 'v1', 'pods', 'Pod'], nodes: ['core', 'v1', 'nodes', 'Node'],
  namespaces: ['core', 'v1', 'namespaces', 'Namespace'], deployments: ['apps', 'v1', 'deployments', 'Deployment'],
  services: ['core', 'v1', 'services', 'Service'], storage: ['core', 'v1', 'persistentvolumeclaims', 'PersistentVolumeClaim'],
  statefulsets: ['apps', 'v1', 'statefulsets', 'StatefulSet'], daemonsets: ['apps', 'v1', 'daemonsets', 'DaemonSet'],
  jobs: ['batch', 'v1', 'jobs', 'Job'],
} as const;
type Resource = keyof typeof RESOURCES;

/** Deterministic summaries from authenticated GETs. Cluster data never enters the model. */
export async function answerClusterQuestion(question: ClusterQuestion, inputScope: QuestionScope, signal: AbortSignal, read: Reader = apiFetch): Promise<ClusterAnswer> {
  if (['query_pods', 'list_configmaps', 'list_secrets', 'lookup_ip', 'lookup_port', 'list_images', 'node_capacity'].includes(question.topic)) return answerExplorationQuestion(question, inputScope, signal, read);
  if (['pod_logs', 'find_pods', 'latest_deployments', 'summarize_events', 'recent_terminations', 'diagnose_pod'].includes(question.topic)) return answerHarnessQuestion(question, inputScope, signal, read);
  const scope = { context: inputScope.context, namespaces: question.namespace ? [question.namespace] : [...inputScope.namespaces] };
  if (question.allNamespaces && !question.namespace) scope.namespaces = [];
  if (['nodes', 'namespaces'].includes(question.topic)) scope.namespaces = [];
  if (!scope.context) throw new Error('Select a connected cluster first.');
  const answer: ClusterAnswer = { scope, question, fetchedAt: new Date().toISOString(), sections: [], notices: [] };
  const base = `/api/contexts/${encodeURIComponent(scope.context)}`;
  async function resources(resource: Resource) {
    const [group, version, plural] = RESOURCES[resource];
    const namespaces = ['nodes', 'namespaces'].includes(resource) ? [''] : scope.namespaces.length ? scope.namespaces : [''];
    const batches = await Promise.all(namespaces.map(async (namespace) => {
      const items: KubeObject[] = [];
      let continuation = '';
      const seen = new Set<string>();
      do {
        const params = new URLSearchParams({ limit: '1000' });
        if (namespace) params.set('namespace', namespace);
        if (question.name) params.set('fieldSelector', `metadata.name=${question.name}`);
        if (continuation) params.set('continue', continuation);
        const page = await read<ListResponse>(`${base}/resources/${group}/${version}/${plural}?${params}`, { signal });
        if (!Array.isArray(page.items)) throw new Error(`Invalid ${plural} response`);
        items.push(...page.items);
        continuation = page.continue ?? '';
        if (continuation && (seen.has(continuation) || items.length >= 10_000)) throw new Error(`${plural} exceeds the report limit; select a narrower namespace scope.`);
        seen.add(continuation);
      } while (continuation);
      // Also enforce scope locally; never depend on a fixture/proxy applying selectors.
      return items.filter((obj) => (!namespace || obj.metadata.namespace === namespace) && (!question.name || obj.metadata.name === question.name));
    }));
    return batches.flat();
  }
  function section(resource: Resource, items: KubeObject[], columns: string[], rows: string[][], summary?: string, title?: string) {
    const [group, version, plural] = RESOURCES[resource];
    return { title: title ?? (resource === 'storage' ? 'Persistent volume claims' : plural[0]!.toUpperCase() + plural.slice(1)), summary: summary ?? `${items.length} ${plural} found.`, columns, rows: rows.slice(0, 20), href: `/r/${group}/${version}/${plural}` };
  }
  async function inventory(resource: Resource): Promise<AnswerSection> {
    const items = await resources(resource);
    items.sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`));
    if (resource === 'pods') {
      return section(resource, items, ['Namespace', 'Pod', 'Status', 'Ready', 'Restarts'], items.map((obj) => {
        const pod = podSummary(obj);
        return [...identity(obj), pod.status, pod.ready, String(pod.restarts)];
      }));
    }
    if (resource === 'nodes') {
      return section(resource, items, ['Node', 'Status', 'Kubernetes', 'CPU capacity', 'Memory capacity'], items.map((obj) => [
        obj.metadata.name, nodeStatus(obj), text(record(obj.status?.nodeInfo).kubeletVersion),
        text(record(obj.status?.capacity).cpu), text(record(obj.status?.capacity).memory),
      ]));
    }
    if (resource === 'deployments') {
      return section(resource, items, ['Namespace', 'Deployment', 'Ready / desired', 'Available'], items.map((obj) => [
        ...identity(obj), `${number(obj.status?.readyReplicas)} / ${text(obj.spec?.replicas ?? 1)}`, text(obj.status?.availableReplicas ?? 0),
      ]));
    }
    if (resource === 'services') {
      return section(resource, items, ['Namespace', 'Service', 'Type', 'Cluster IP', 'Ports'], items.map((obj) => [
        ...identity(obj), text(obj.spec?.type), text(obj.spec?.clusterIP), list(obj.spec?.ports).map((port) => `${text(port.port)}/${text(port.protocol ?? 'TCP')}`).join(', '),
      ]));
    }
    if (resource === 'storage') {
      return section(resource, items, ['Namespace', 'PVC', 'Phase', 'Storage class', 'Requested', 'Volume'], items.map((obj) => [
        ...identity(obj), text(obj.status?.phase), text(obj.spec?.storageClassName), text(record(record(obj.spec?.resources).requests).storage), text(obj.spec?.volumeName),
      ]));
    }
    return section(resource, items, ['Namespace', 'Phase'], items.map((obj) => [obj.metadata.name, text(obj.status?.phase)]));
  }

  const { topic } = question;
  if (topic in RESOURCES) {
    answer.sections.push(await inventory(topic as Resource));
    if (['nodes', 'namespaces'].includes(topic)) answer.notices.push('This inventory is cluster-wide; namespace selections do not apply.');
    if (topic === 'pods' && question.name) answer.notices.push('Pod status is an observation, not a root-cause diagnosis. Ask for warning events for this pod to see reported reasons.');
  } else if (topic === 'overview' || topic === 'health') {
    const kinds: Resource[] = topic === 'overview' ? ['nodes', 'pods', 'deployments', 'services', 'storage'] : ['nodes', 'pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'storage'];
    const results = await Promise.allSettled(kinds.map(async (resource) => ({ resource, items: await resources(resource) })));
    const counts: string[][] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        answer.notices.push(`${RESOURCES[kinds[index]!][2]} unavailable: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        return;
      }
      const { resource, items } = result.value;
      const kind = RESOURCES[resource][3];
      const unhealthy = items.filter((obj) => !isResourceHealthy(kind, obj));
      counts.push([kind, String(items.length), String(unhealthy.length)]);
      if (topic === 'health' && unhealthy.length) {
        answer.sections.push(section(resource, unhealthy, ['Namespace', 'Name', 'Observed status'], unhealthy.map((obj) => [
          ...identity(obj), resource === 'pods' ? podSummary(obj).status : resource === 'nodes' ? nodeStatus(obj) :
            list(obj.status?.conditions).filter((condition) => condition.status === 'False' || condition.type === 'Failed').map((condition) => `${text(condition.type)}: ${text(condition.reason ?? condition.message)}`).join('; ') || text(obj.status?.phase ?? 'Not healthy'),
        ]), `${unhealthy.length} of ${items.length} ${RESOURCES[resource][2]} need attention.`));
      }
    });
    if (!counts.length) throw new Error(answer.notices.join(' '));
    answer.sections.unshift({ title: topic === 'health' ? 'Observed health' : 'Cluster overview', summary: 'Counts cover the resource types listed below.', columns: ['Kind', 'Total', 'Not healthy'], rows: counts });
    answer.notices.push('Nodes are cluster-wide. Workloads and PVCs use the namespace scope. Health uses Kubus status checks and does not prove application reachability.');
  } else if (topic === 'events') {
    const namespaces = scope.namespaces.length ? scope.namespaces : [''];
    const groups = await Promise.all(namespaces.map(async (namespace) => {
      const params = new URLSearchParams();
      if (namespace) params.set('namespace', namespace);
      if (question.name) params.set('involvedName', question.name);
      const result = await read<{ items: KubeObject[] }>(`${base}/events?${params}`, { signal });
      return result.items.filter((event) => event.type === 'Warning' && (!namespace || event.metadata.namespace === namespace) && (!question.name || record(event.involvedObject).name === question.name));
    }));
    const events = groups.flat();
    const when = (event: KubeObject) => text(record(event.series).lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp);
    events.sort((a, b) => (Date.parse(when(b)) || 0) - (Date.parse(when(a)) || 0));
    answer.sections.push({ title: 'Recent warning events', summary: `${events.length} retained warning events.`, columns: ['Namespace', 'Resource', 'Reason', 'Message', 'Last observed'], rows: events.slice(0, 20).map((event) => [
      event.metadata.namespace ?? '—', text(record(event.involvedObject).name), text(event.reason), text(event.message), when(event),
    ]), href: '/events' });
    answer.notices.push('Events are retained by Kubernetes for a limited time. Absence of events does not establish absence of problems.');
  } else if (topic === 'cpu' || topic === 'memory') {
    const groups = await Promise.all((scope.namespaces.length ? scope.namespaces : ['']).map(async (namespace) => {
      const snapshot = await read<MetricsSnapshot>(`${base}/metrics/pods${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`, { signal });
      if (!snapshot.available) throw new Error(snapshot.probed ? 'Pod usage metrics are unavailable. Check metrics-server and permissions.' : 'Metrics have not been sampled yet. Try again shortly.');
      return snapshot.items.filter((item) => (!namespace || item.namespace === namespace) && (!question.name || item.name === question.name));
    }));
    const items = groups.flat();
    const value = (item: typeof items[number]) => topic === 'cpu' ? item.cpuMilli : item.memBytes;
    const format = (amount: number) => topic === 'cpu' ? `${(amount / 1000).toFixed(3)} cores` : mib(amount);
    items.sort((a, b) => value(b) - value(a));
    answer.sections.push({ title: topic === 'cpu' ? 'Pod CPU usage' : 'Pod memory usage', summary: `${format(items.reduce((sum, item) => sum + value(item), 0))} across ${items.length} sampled pods.`, columns: ['Namespace', 'Pod', 'Usage'], rows: items.slice(0, 20).map((item) => [item.namespace ?? '—', item.name, format(value(item))]), href: '/metrics' });
    answer.notices.push('These are the latest available pod samples, not total node usage or historical measurements. Unsampled pods are not counted.');
    if (!scope.namespaces.length) {
      try {
        const snapshot = await read<MetricsSnapshot>(`${base}/metrics/nodes`, { signal });
        if (!snapshot.available) throw new Error('Node usage metrics are unavailable.');
        const nodes = snapshot.items.filter((item) => !question.name || item.name === question.name).sort((a, b) => value(b) - value(a));
        answer.sections.push({ title: topic === 'cpu' ? 'Node CPU usage' : 'Node memory usage', summary: `${format(nodes.reduce((sum, item) => sum + value(item), 0))} across ${nodes.length} sampled nodes, including system components.`, columns: ['Node', 'Usage'], rows: nodes.slice(0, 20).map((item) => [item.name, format(value(item))]), href: '/metrics' });
      } catch (error) { answer.notices.push(error instanceof Error ? error.message : 'Node usage could not be read.'); }
    }
  } else {
    const items = await resources('pods');
    if (topic === 'restarts') {
      items.sort((a, b) => podSummary(b).restarts - podSummary(a).restarts);
      answer.sections.push(section('pods', items, ['Namespace', 'Pod', 'Restarts', 'Status'], items.map((obj) => [...identity(obj), String(podSummary(obj).restarts), podSummary(obj).status]), `${items.reduce((sum, obj) => sum + podSummary(obj).restarts, 0)} recorded container restarts across ${items.length} pods.`, 'Pod restarts'));
      answer.notices.push('Restart counts belong to current pod/container status; they are not a historical restart rate.');
    } else {
      const rows = items.flatMap((obj) => [...list(obj.spec?.initContainers), ...list(obj.spec?.containers)].map((container) => [...identity(obj), text(container.name), text(container.image)]));
      answer.sections.push(section('pods', items, ['Namespace', 'Pod', 'Container', 'Image'], rows, `${rows.length} container specifications across ${items.length} pods.`, 'Container images'));
      answer.notices.push('Images come from pod specifications, including init containers; their presence does not prove a container is running.');
    }
  }
  if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
  answer.fetchedAt = new Date().toISOString();
  answer.notices.push('Tables show up to 20 rows; totals use the fetched scope. Ask another question to refresh.');
  return answer;
}
