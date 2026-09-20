import { cpuToMilli, memToBytes, type KubeObject, type MetricsSnapshot, type MetricsSnapshotEntry } from '@kubus/shared';
import { nodeStatus, podSummary } from '../kube-display.js';
import { isResourceHealthy } from '../smart-filter.js';
import type { ClusterAnswer, QuestionScope } from './cluster-answer.js';
import type { ClusterQuestion } from './cluster-query.js';
import { podMatch } from './harness-answer.js';
import { normalizeIP } from './explore-query.js';
import { evidenceReader, errorMessage, list, record, stamp, text, type EvidenceReader, type EvidenceResource } from './evidence-reader.js';

const order = (a: KubeObject, b: KubeObject) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`);
const identity = (obj: KubeObject) => [obj.metadata.namespace ?? '—', obj.metadata.name];
const choice = (pod: KubeObject) => ({ name: pod.metadata.name, namespace: pod.metadata.namespace ?? '', uid: pod.metadata.uid });
const cores = (value: number) => `${(value / 1000).toFixed(3)} cores`;
const memory = (value: number) => `${(value / 1024 ** 3).toFixed(2)} GiB`;
const quantity = (value: unknown, cpu: boolean) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = cpu ? cpuToMilli(value) : memToBytes(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Configured pod requests, including sequential init phases, sidecars and overhead.
 * This is a spec estimate, not a scheduler simulation (resize state, taints, etc.). */
export function configuredPodRequest(pod: KubeObject, resource: 'cpu' | 'memory'): number {
  const request = (container: Record<string, unknown>) => quantity(record(record(container.resources).requests)[resource], resource === 'cpu') ?? 0;
  let sidecars = 0, initPeak = 0;
  for (const init of list(pod.spec?.initContainers)) {
    if (init.restartPolicy === 'Always') sidecars += request(init);
    initPeak = Math.max(initPeak, sidecars + (init.restartPolicy === 'Always' ? 0 : request(init)));
  }
  const containers = list(pod.spec?.containers).reduce((sum, container) => sum + request(container), 0) + sidecars;
  const podLevel = quantity(record(record(pod.spec?.resources).requests)[resource], resource === 'cpu');
  return (podLevel ?? Math.max(containers, initPeak)) + (quantity(record(pod.spec?.overhead)[resource], resource === 'cpu') ?? 0);
}

export async function answerExplorationQuestion(question: ClusterQuestion, inputScope: QuestionScope, signal: AbortSignal, read: EvidenceReader): Promise<ClusterAnswer> {
  const scope = { context: inputScope.context, namespaces: question.namespace ? [question.namespace] : question.allNamespaces ? [] : [...inputScope.namespaces] };
  if (question.topic === 'node_capacity' || (question.topic === 'list_images' && question.source === 'cached')) scope.namespaces = [];
  if (!scope.context) throw new Error('Select a connected cluster first.');
  const answer: ClusterAnswer = { scope, question, sections: [], notices: [], fetchedAt: '' };
  const { get, objects, href } = evidenceReader(scope, signal, read);
  const limit = question.limit ?? (question.sort === 'oldest' || question.sort === 'newest' ? 1 : 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Request between 1 and 20 results.');
  const table = (title: string, summary: string, columns: string[], rows: string[][], links?: string[]) => {
    answer.sections.push({ title, summary, columns, rows: rows.slice(0, limit), ...(links ? { rowLinks: links.slice(0, limit) } : {}) });
  };
  if (question.topic === 'query_pods') {
    let pods = (await objects('pods')).filter((pod) => (!question.name || podMatch(pod, question.name).length) && (!question.node || pod.spec?.nodeName === question.node));
    if (question.status) pods = pods.filter((pod) => {
      if (question.status === 'unhealthy') return !isResourceHealthy('Pod', pod);
      if (question.status === 'not_ready') return !['Succeeded', 'Failed'].includes(String(pod.status?.phase)) && !list(pod.status?.conditions).some((condition) => condition.type === 'Ready' && condition.status === 'True');
      if (question.status === 'CrashLoopBackOff') return [...list(pod.status?.containerStatuses), ...list(pod.status?.initContainerStatuses)].some((container) => record(record(container.state).waiting).reason === 'CrashLoopBackOff');
      return pod.status?.phase === question.status;
    });
    const count = pods.length;
    const usage = new Map<string, MetricsSnapshotEntry>();
    if (question.sort === 'cpu' || question.sort === 'memory') {
      for (const namespace of scope.namespaces.length ? scope.namespaces : ['']) {
        const metrics = await get<MetricsSnapshot>(`/metrics/pods${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`);
        if (!metrics.available) throw new Error('Pod usage metrics are unavailable. Check metrics-server and permissions.');
        for (const sample of metrics.items) if (!namespace || sample.namespace === namespace) usage.set(`${sample.namespace}/${sample.name}`, sample);
      }
      pods = pods.filter((pod) => usage.has(`${pod.metadata.namespace}/${pod.metadata.name}`));
      answer.notices.push(`Usage samples cover ${pods.length} of ${count} matching pods. Missing samples are excluded, not treated as zero. These are latest available samples, not historical peaks. Metrics are matched by namespace/name and can lag a pod replacement.`);
    }
    if (question.sort === 'oldest' || question.sort === 'newest') {
      pods = pods.filter((pod) => Number.isFinite(stamp(pod.metadata.creationTimestamp)));
      if (pods.length < count) answer.notices.push(`${count - pods.length} matching pods lack a usable creation timestamp and cannot be ranked.`);
    }
    const value = (pod: KubeObject) => {
      if (question.sort === 'oldest') return stamp(pod.metadata.creationTimestamp);
      if (question.sort === 'newest') return -stamp(pod.metadata.creationTimestamp);
      if (question.sort === 'restarts') return -podSummary(pod).restarts;
      const sample = usage.get(`${pod.metadata.namespace}/${pod.metadata.name}`);
      return question.sort === 'cpu' ? -(sample?.cpuMilli ?? 0) : question.sort === 'memory' ? -(sample?.memBytes ?? 0) : 0;
    };
    pods.sort((a, b) => value(a) - value(b) || order(a, b));
    const filters = [question.name && `matching “${question.name}”`, question.node && `on node ${question.node}`, question.status && `${['Running', 'Pending', 'Failed', 'Succeeded', 'Unknown'].includes(question.status) ? 'phase' : 'condition'} ${question.status.replace('_', ' ')}`].filter(Boolean).join(', ');
    const sortLabel = question.sort ? ` Sorted by ${question.sort}${question.sort === 'oldest' || question.sort === 'newest' ? ' creation time' : ' (highest first)'}.` : '';
    const metricsColumn = question.sort === 'cpu' || question.sort === 'memory';
    const totalUsage = metricsColumn ? pods.reduce((sum, pod) => {
      const sample = usage.get(`${pod.metadata.namespace}/${pod.metadata.name}`)!;
      return sum + (question.sort === 'cpu' ? sample.cpuMilli : sample.memBytes);
    }, 0) : 0;
    const usageSummary = metricsColumn ? ` ${question.sort === 'cpu' ? cores(totalUsage) : memory(totalUsage)} across ${pods.length} sampled matching pods.` : '';
    table('Pod status', `${count} ${count === 1 ? 'pod' : 'pods'}${filters ? ` ${filters}` : ''}; showing ${Math.min(limit, pods.length)}.${sortLabel}${usageSummary}`, ['Namespace', 'Pod', 'Status', 'Ready', 'Restarts', 'Node', 'Created', ...(metricsColumn ? ['Usage'] : [])], pods.map((pod) => {
      const summary = podSummary(pod), sample = usage.get(`${pod.metadata.namespace}/${pod.metadata.name}`);
      return [...identity(pod), summary.status, summary.ready, String(summary.restarts), text(pod.spec?.nodeName), text(pod.metadata.creationTimestamp), ...(metricsColumn ? [question.sort === 'cpu' ? cores(sample!.cpuMilli) : memory(sample!.memBytes)] : [])];
    }), pods.map((pod) => href('pods', pod)));
    answer.candidates = pods.slice(0, limit).map(choice);
    answer.sections[0]!.rowPods = answer.candidates;
    if (pods.length === 1) answer.focus = choice(pods[0]!);
    if (question.status === 'Running') answer.notices.push('Running is the Kubernetes pod phase. A pod in that phase can still have an unready or crashing container; the Status and Ready columns show that distinction.');
    if (question.name) answer.notices.push(`Filter “${question.name}” matches pod names, labels or container images. Other selected conditions are combined with AND.`);
    if (question.sort === 'oldest' || question.sort === 'newest') answer.notices.push('Creation time ranks existing Pod objects; it is not container uptime or a history of deleted pods.');
  } else if (question.topic === 'list_configmaps' || question.topic === 'list_secrets') {
    const resource = question.topic === 'list_secrets' ? 'secrets' : 'configmaps';
    const items = (await objects(resource)).filter((obj) => !question.name || podMatch(obj, question.name).length).sort(order);
    table(resource === 'secrets' ? 'Secrets' : 'ConfigMaps', `${items.length} ${resource === 'secrets' ? 'Secret' : 'ConfigMap'}${items.length === 1 ? '' : 's'}${question.name ? ` matching “${question.name}”` : ''} in this scope.`, ['Namespace', 'Name', 'Created'], items.map((obj) => [...identity(obj), text(obj.metadata.creationTimestamp)]), items.map((obj) => href(resource, obj)));
    answer.notices.push('This inventory returns only names, labels and creation timestamps. Secret data and ConfigMap contents are excluded.');
  } else if (question.topic === 'list_images') {
    const source = question.source ?? 'workloads';
    if (source !== 'cached') {
      try {
        const pods = (await objects('pods')).filter((pod) => (!question.node || pod.spec?.nodeName === question.node) && (!question.imagePodQuery || !question.name || podMatch(pod, question.name).length));
        const images = new Map<string, { pods: Set<string>; namespaces: Set<string>; containers: number }>();
        for (const pod of pods) for (const container of [...list(pod.spec?.containers), ...list(pod.spec?.initContainers), ...list(pod.spec?.ephemeralContainers)]) {
          const image = text(container.image);
          if (!question.imagePodQuery && question.name && !image.toLowerCase().includes(question.name.toLowerCase())) continue;
          const entry = images.get(image) ?? { pods: new Set(), namespaces: new Set(), containers: 0 };
          entry.pods.add(pod.metadata.uid); entry.namespaces.add(pod.metadata.namespace ?? ''); entry.containers++;
          images.set(image, entry);
        }
        const rows = [...images].sort(([a], [b]) => a.localeCompare(b));
        table('Workload images', `${rows.length} distinct image references in the selected pod specifications.`, ['Image', 'Pods', 'Containers', 'Namespaces'], rows.map(([image, data]) => [image, String(data.pods.size), String(data.containers), [...data.namespaces].sort().join(', ')]));
        answer.notices.push('Workload images include regular, init and ephemeral container specifications. A reference does not prove a successful image pull.');
      } catch (error) { signal.throwIfAborted(); if (source !== 'both') throw error; answer.notices.push(`Workload images unavailable: ${errorMessage(error)}`); }
    }
    if (source !== 'workloads') {
      try {
        const nodes = (await objects('nodes')).filter((obj) => !question.node || obj.metadata.name === question.node);
        if (question.node && !nodes.length) throw new Error(`Node ${question.node} was not found.`);
        const images = new Map<string, Set<string>>();
        let reported = 0;
        for (const node of nodes) {
          if (Array.isArray(node.status?.images)) reported++;
          for (const entry of list(node.status?.images)) for (const name of Array.isArray(entry.names) ? entry.names : []) {
            if (typeof name !== 'string' || (question.name && !name.toLowerCase().includes(question.name.toLowerCase()))) continue;
            const hosts = images.get(name) ?? new Set(); hosts.add(node.metadata.name); images.set(name, hosts);
          }
        }
        table('Node image cache', `${images.size} reported image names from ${reported} of ${nodes.length} nodes.`, ['Image name or digest', 'Nodes'], [...images].sort(([a], [b]) => a.localeCompare(b)).map(([name, hosts]) => [name, [...hosts].sort().join(', ')]));
        answer.notices.push('Node image status is cluster-wide, may be capped or stale, and lists aliases for the same image. It is not a registry catalog or proof that an image is pullable.');
      } catch (error) { signal.throwIfAborted(); if (source !== 'both') throw error; answer.notices.push(`Node image cache unavailable: ${errorMessage(error)}`); }
    }
    if (!answer.sections.length) throw new Error(answer.notices.join(' '));
  } else if (question.topic === 'node_capacity') {
    const nodes = (await objects('nodes')).filter((obj) => !question.node || obj.metadata.name === question.node).sort(order);
    if (!nodes.length) throw new Error(question.node ? `Node ${question.node} was not found.` : 'No nodes were returned.');
    let samples: MetricsSnapshotEntry[] = [], pods: KubeObject[] | undefined;
    try {
      const metrics = await get<MetricsSnapshot>('/metrics/nodes');
      if (!metrics.available) throw new Error('Node usage metrics are unavailable. Check metrics-server and permissions.');
      samples = metrics.items;
    } catch (error) { signal.throwIfAborted(); answer.notices.push(errorMessage(error)); }
    try { pods = await objects('pods', []); } catch (error) { signal.throwIfAborted(); answer.notices.push(`Pod requests unavailable: ${errorMessage(error)}`); }
    const active = pods?.filter((pod) => !['Succeeded', 'Failed'].includes(String(pod.status?.phase)));
    for (const resource of ['cpu', 'memory'] as const) {
      const format = resource === 'cpu' ? cores : memory;
      const values = nodes.map((node) => {
        const capacity = quantity(record(node.status?.capacity)[resource], resource === 'cpu');
        const allocatable = quantity(record(node.status?.allocatable)[resource], resource === 'cpu');
        const sample = samples.find((entry) => entry.name === node.metadata.name);
        const usage = sample ? resource === 'cpu' ? sample.cpuMilli : sample.memBytes : undefined;
        const requested = active?.filter((pod) => pod.spec?.nodeName === node.metadata.name).reduce((sum, pod) => sum + configuredPodRequest(pod, resource), 0);
        return { node, capacity, allocatable, usage, requested };
      });
      const show = (value: number | undefined) => value === undefined ? 'Unavailable' : format(value);
      const rows = values.map(({ node, capacity, allocatable, usage, requested }) => [node.metadata.name, nodeStatus(node) + (node.spec?.unschedulable ? ' (cordoned)' : ''), show(capacity), show(allocatable), show(usage), show(capacity !== undefined && usage !== undefined ? capacity - usage : undefined), show(requested), show(allocatable !== undefined && requested !== undefined ? allocatable - requested : undefined)]);
      const totals = (key: 'capacity' | 'allocatable' | 'usage' | 'requested') => values.every((entry) => entry[key] !== undefined) ? values.reduce((sum, entry) => sum + entry[key]!, 0) : undefined;
      const capacity = totals('capacity'), allocatable = totals('allocatable'), usage = totals('usage'), requested = totals('requested');
      if (nodes.length > 1) rows.unshift(['Total', `${nodes.length} nodes`, show(capacity), show(allocatable), show(usage), show(capacity !== undefined && usage !== undefined ? capacity - usage : undefined), show(requested), show(allocatable !== undefined && requested !== undefined ? allocatable - requested : undefined)]);
      table(resource === 'cpu' ? 'CPU capacity and headroom' : 'Memory capacity and headroom', `${samples.filter((sample) => nodes.some((node) => node.metadata.name === sample.name)).length} of ${nodes.length} nodes have usage samples. Totals are unavailable if any node lacks the required data.`, ['Node', 'Status', 'Capacity', 'Allocatable', 'Usage', 'Capacity − usage', 'Pod requests', 'Allocatable − requests'], rows, [...(nodes.length > 1 ? ['/r/core/v1/nodes'] : []), ...nodes.map((node) => href('nodes', node))]);
    }
    answer.notices.push('Node capacity is cluster-wide; namespace selections do not apply. Capacity minus sampled usage estimates current headroom; memory usage is working set, not the operating system’s free-memory counter.');
    answer.notices.push('Allocatable minus configured requests estimates unreserved pod capacity, including init sidecars and overhead. It is not a scheduling guarantee: taints, placement, in-place resize and other resource constraints still apply. Cordoned and unready nodes remain in totals and are identified.');
  } else if (question.topic === 'lookup_ip' || question.topic === 'lookup_port') {
    const ip = question.ip ? normalizeIP(question.ip) : undefined;
    if (question.topic === 'lookup_ip' && !ip) throw new Error('Include a valid IP address.');
    if (question.topic === 'lookup_port' && (!Number.isInteger(question.port) || question.port! < 1 || question.port! > 65535)) throw new Error('Include a valid port.');
    const rows: string[][] = [], links: string[] = [];
    let successful = 0;
    const matchIP = (value: unknown) => typeof value === 'string' && normalizeIP(value) === ip;
    const matchPort = (value: unknown, protocol: unknown = 'TCP') => value === question.port && (!question.protocol || protocol === question.protocol);
    const hit = (resource: EvidenceResource, obj: KubeObject, field: string, value: string) => { rows.push([obj.kind ?? resource, ...identity(obj), field, value]); links.push(href(resource, obj)); };
    for (const resource of ['services', 'pods', 'endpointslices', 'ingresses', ...(ip ? ['nodes'] as const : [])] as const) {
      if (question.networkKind && resource !== question.networkKind) continue;
      try {
        const items = await objects(resource); successful++;
        for (const obj of items.sort(order)) {
          if (ip) {
            const candidates: [string, unknown][] = resource === 'services' ? [
              ['clusterIP', obj.spec?.clusterIP], ...((Array.isArray(obj.spec?.clusterIPs) ? obj.spec.clusterIPs : []).map((value: unknown) => ['clusterIPs', value] as [string, unknown])),
              ...((Array.isArray(obj.spec?.externalIPs) ? obj.spec.externalIPs : []).map((value: unknown) => ['externalIPs', value] as [string, unknown])),
              ...list(record(obj.status?.loadBalancer).ingress).map((entry) => ['loadBalancer', entry.ip] as [string, unknown]),
            ] : resource === 'pods' ? [['podIP', obj.status?.podIP], ...list(obj.status?.podIPs).map((entry) => ['podIPs', entry.ip] as [string, unknown]), ['hostIP (node address)', obj.status?.hostIP], ...list(obj.status?.hostIPs).map((entry) => ['hostIPs (node address)', entry.ip] as [string, unknown])]
              : resource === 'nodes' ? list(obj.status?.addresses).map((entry) => [text(entry.type), entry.address] as [string, unknown])
              : resource === 'ingresses' ? list(record(obj.status?.loadBalancer).ingress).map((entry) => ['loadBalancer', entry.ip] as [string, unknown])
              : list(obj.endpoints).flatMap((entry) => (Array.isArray(entry.addresses) ? entry.addresses : []).map((address: unknown) => [`endpoint (${record(entry.conditions).ready === false ? 'not ready' : 'ready/unknown'})${record(entry.targetRef).name ? ` → ${text(record(entry.targetRef).name)}` : ''}`, address] as [string, unknown]));
            const matched = candidates.filter(([, value]) => matchIP(value));
            if (matched.length) hit(resource, obj, [...new Set(matched.map(([field]) => field))].join('; '), ip);
          } else if (resource === 'services') {
            for (const port of list(obj.spec?.ports)) for (const field of ['port', 'targetPort', 'nodePort']) if (matchPort(port[field], port.protocol ?? 'TCP')) hit(resource, obj, `Service ${field}`, `${text(port[field])}/${text(port.protocol ?? 'TCP')}${port.name ? ` (${text(port.name)})` : ''}`);
          } else if (resource === 'pods') {
            for (const container of [...list(obj.spec?.containers), ...list(obj.spec?.initContainers)]) for (const port of list(container.ports)) for (const field of ['containerPort', 'hostPort']) if (matchPort(port[field], port.protocol ?? 'TCP')) hit(resource, obj, `${text(container.name)} ${field}`, `${text(port[field])}/${text(port.protocol ?? 'TCP')}`);
          } else if (resource === 'endpointslices') {
            for (const port of list(obj.ports)) if (matchPort(port.port, port.protocol ?? 'TCP')) hit(resource, obj, `EndpointSlice port${obj.metadata.labels?.['kubernetes.io/service-name'] ? ` → ${obj.metadata.labels['kubernetes.io/service-name']}` : ''}`, `${text(port.port)}/${text(port.protocol ?? 'TCP')}`);
          } else if (resource === 'ingresses') {
            const backends = [record(obj.spec?.defaultBackend), ...list(obj.spec?.rules).flatMap((rule) => list(record(rule.http).paths).map((path) => record(path.backend)))];
            for (const backend of backends) if (matchPort(record(record(backend.service).port).number)) hit(resource, obj, 'Ingress backend service port', `${text(record(backend.service).name)}:${question.port}/TCP`);
            if (question.port === 443 && (!question.protocol || question.protocol === 'TCP') && list(obj.spec?.tls).length) hit(resource, obj, 'TLS configured (usual HTTPS port)', '443/TCP; controller listener must be verified');
          }
        }
      } catch (error) { signal.throwIfAborted(); answer.notices.push(`${resource} unavailable: ${errorMessage(error)}`); }
    }
    if (!successful) throw new Error(answer.notices.join(' '));
    table(ip ? `IP references: ${question.ip}` : `Configured port: ${question.port}${question.protocol ? `/${question.protocol}` : ''}`, `${rows.length} matching ${rows.length === 1 ? 'reference' : 'references'} in ${successful} resource ${successful === 1 ? 'inventory' : 'inventories'}.${answer.notices.length ? ' Coverage is incomplete; see unavailable sources below.' : ''}`, ['Kind', 'Namespace', 'Resource', 'Evidence', 'Value'], rows, links);
    answer.notices.push(ip ? 'Matches are references, not exclusive ownership: hostIP points to the node, and EndpointSlices describe backends. Node addresses are cluster-wide. External DNS and resources outside these inventories are not searched.' : 'These are declared ports and endpoint records, not a port scan. Reachability, network policies, firewall rules and actual listening processes are not tested. Named target ports are visible through pod/EndpointSlice declarations when available.');
  } else throw new Error('Unsupported exploration workflow.');
  signal.throwIfAborted();
  answer.fetchedAt = new Date().toISOString();
  answer.notices.push(`Tables show up to ${limit} rows; counts cover the fetched scope. Ask again to refresh.`);
  return answer;
}
