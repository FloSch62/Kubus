import type { ClusterQuestion } from './cluster-query.js';

const namespace = { type: 'string', description: 'Explicit namespace, if given.' };
const query = { type: 'string', description: 'Literal resource name, label key=value or image search text from the question.' };
const node = { type: 'string', description: 'Exact node name explicitly stated, if given.' };
const limit = { type: 'integer', minimum: 1, maximum: 20, description: 'Explicit number of results requested.' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
});
export const POD_SORTS = ['oldest', 'newest', 'restarts', 'cpu', 'memory'] as const;
export const POD_STATES = ['Running', 'Pending', 'Failed', 'Succeeded', 'Unknown', 'unhealthy', 'not_ready', 'CrashLoopBackOff'] as const;
export const EXPLORE_TOOLS = [
  tool('query_pods', 'Filter pod status by name, label, image, node or state; rank by age, restarts or usage.', {
    query, namespace, node, status: { type: 'string', enum: [...POD_STATES] }, sort: { type: 'string', enum: [...POD_SORTS] }, limit,
  }),
  tool('pod_logs', 'Read current or previous logs of one named pod; choose if several match.', {
    query, namespace, container: { type: 'string', description: 'Explicit container name, if given.' }, previous: { type: 'boolean', description: 'True only when previous logs are requested.' },
  }, ['query']),
  tool('list_configmaps', 'List or count ConfigMap names without reading their contents.', { query, namespace }),
  tool('list_secrets', 'List or count Secret names, never secret values.', { query, namespace }),
  tool('lookup_ip', 'Find a literal IP in Services, pods, nodes, ingress and EndpointSlices.', { ip: { type: 'string', description: 'Literal IPv4 or IPv6 address from the question.' }, namespace }, ['ip']),
  tool('lookup_port', 'Find configured service, container and ingress ports; does not test connectivity.', {
    port: { type: 'integer', minimum: 1, maximum: 65535 }, protocol: { type: 'string', enum: ['TCP', 'UDP', 'SCTP'] }, namespace,
  }, ['port']),
  tool('list_images', 'List images used by pods, cached on nodes, or both. Available images means both.', {
    source: { type: 'string', enum: ['workloads', 'cached', 'both'] }, query, namespace, node,
  }, ['source']),
  tool('node_capacity', 'Show node or cluster CPU and memory capacity, requests and measured headroom.', { node }),
];

/** Candidate selection is explicit; the model still chooses and extracts arguments. */
export function explorationCandidates(prompt: string): string[] {
  const result: string[] = [];
  if (/\b(?:pods?|containers?|restarts?)\b/i.test(prompt) || /\b(?:oldest|newest)\b/i.test(prompt)) result.push('query_pods');
  if (/\blogs?\b/i.test(prompt)) result.push('pod_logs');
  if (/\bconfig[ -]?maps?\b/i.test(prompt)) result.push('list_configmaps');
  if (/\bsecrets?\b/i.test(prompt)) result.push('list_secrets');
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b|[a-f0-9]*:[a-f0-9:]*:[a-f0-9:]*/i.test(prompt)) result.push('lookup_ip');
  if (/\b\d{1,5}\b/.test(prompt) && /\bports?\b|\b(?:TCP|UDP|SCTP)\b/i.test(prompt)) result.push('lookup_port');
  if (/\bimages?\b/i.test(prompt)) result.push('list_images');
  if (/\b(?:free|available|spare|remaining|allocatable|capacity|headroom|unrequested)\b/i.test(prompt) && /\b(?:cpu|memory|ram|cores?|resources?|capacity|headroom)\b/i.test(prompt)) result.push('node_capacity');
  return result;
}

const quote = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literal = (value: string, prompt: string) => new RegExp(`(?<![\\w./:=~-])${quote(value)}(?![\\w/:=~-]|\\.[\\w.-])`, value.includes('=') ? '' : 'i').test(prompt);
const namePattern = /^[a-z0-9][a-z0-9._/:=~-]{0,252}$/i;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const generic = /^(?:inventory|summary|details|secrets?|config-?maps?|namespaces?|nodes?|ports?|tags|tag|versions|version|order|one|two|three|four|five|ten|twenty|show|list|rank|inspect|check|find|locate|search|diagnose|debug|existing|phases|phase|restarting|by|per|each|of|for|from|in|on|with|are|is|do|have|our|your|all|my|the|these|those|a|any|which|what|how|many|cluster|kubernetes|status|statuses|current|crashlooping|crashloopbackoff|running|pending|failed|failing|completed|succeeded|unknown|unhealthy|ready|oldest|newest|latest|recent|most|top|available|cached|used|container|pod|pods|it|restart|restarts|counts|count|images|image|logs|log|cpu|memory|ram)$/i;

/** Detect explicit filters that must not disappear during model extraction. */
export function requestedPodQuery(prompt: string): string | undefined {
  const token = '([a-z0-9][a-z0-9._/:=~-]*)';
  const patterns = [
    new RegExp(`\\b(?:matching|named|called|using|containing)\\s+["']?${token}`, 'i'),
    new RegExp(`\\b(?:label|image)\\s+["']?${token}`, 'i'),
    new RegExp(`\\b${token}\\s+pods?\\b`, 'i'),
    new RegExp(`\\b(?:for|of|from|diagnose|debug|troubleshoot|locate|inspect|check|show)\\s+(?:the\\s+|my\\s+)?pod\\s+["']?${token}`, 'i'),
    new RegExp(`\\bpod\\s+["']?${token}\\s+(?:failing|in|on|is|status)\\b`, 'i'),
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    const value = pattern.exec(prompt)?.[1]?.replace(/\.$/, '');
    if (value && !generic.test(value) && !/^\d+$/.test(value)) found.add(value.toLowerCase());
  }
  if (found.size > 1 || (prompt.match(/[a-z0-9_./-]+=[a-z0-9_.:-]+/gi)?.length ?? 0) > 1) throw new Error('Use one pod name, label or image match per question; node, status and namespace filters can be combined with it.');
  return [...found][0];
}

export function explicitNamespace(prompt: string): string | undefined {
  const values = [...prompt.matchAll(/\b(?:in\s+(?:namespace\s+)?|namespace\s+)["']?([a-z0-9][-a-z0-9]*)(?=$|[\s"'.,!?])/gi)]
    .filter((match) => /^in\s+namespace\b/i.test(match[0]) || !['which', 'my', 'the', 'this', 'all', 'kubus', 'kubernetes', 'use', 'is', 'contains', 'names', 'count', 'list', 'phases', 'inventory'].includes(match[1]!.toLowerCase()))
    .map((match) => match[1]!.toLowerCase());
  const before = /\b([a-z0-9][-a-z0-9]*)\s+namespace\b/i.exec(prompt)?.[1]?.toLowerCase();
  if (before && !['in', 'which', 'a', 'the', 'one', 'my', 'all', 'every', 'each', 'show', 'list'].includes(before)) values.push(before);
  if (new Set(values).size > 1) throw new Error('Name one namespace or ask across all namespaces.');
  return values[0];
}
export function requestedCount(prompt: string): number | undefined {
  const count = /\b(?:last|latest|newest|oldest|recent|top|show|summarize|summarise|list)\s+(\d+|one|two|three|five|ten|twenty)\b/i.exec(prompt)?.[1]?.toLowerCase();
  const words: Record<string, number> = { one: 1, two: 2, three: 3, five: 5, ten: 10, twenty: 20 };
  return count ? words[count] ?? Number(count) : undefined;
}
// Resource identifiers and scope names can contain words such as cpu or pending.
// Those words are data, not a second condition in the question.
function conditionText(prompt: string): string {
  return prompt.replace(/\b(?:namespace|(?:on|for|of)\s+(?:the\s+)?node)\s+["']?[a-z0-9][a-z0-9._/:=~-]*/gi, '')
    .replace(/\b[a-z0-9][-a-z0-9]*\s+namespace\b/gi, '');
}
const conditionWord = (prompt: string, pattern: string) => new RegExp(`(?<![\\w./:=~-])(?:${pattern})(?![\\w./:=~-])`, 'i').test(prompt);
export function requestedSort(prompt: string): ClusterQuestion['sort'] {
  prompt = conditionText(prompt);
  if (/\boldest\b|\bcreated first\b/i.test(prompt)) return 'oldest';
  if (/\bnewest\b|\blatest pod\b|\bmost recently created\b/i.test(prompt)) return 'newest';
  if (conditionWord(prompt, 'cpu|processor')) return 'cpu';
  if (conditionWord(prompt, 'memory|ram')) return 'memory';
  if (conditionWord(prompt, 'restart(?:s|ed|ing)?')) return 'restarts';
  return undefined;
}
export function requestedState(prompt: string): ClusterQuestion['status'] {
  prompt = conditionText(prompt);
  if (conditionWord(prompt, 'crashloop(?:backoff|ing)?')) return 'CrashLoopBackOff';
  if (/\bnot[ -]ready\b/i.test(prompt)) return 'not_ready';
  if (conditionWord(prompt, 'unhealthy|failing')) return 'unhealthy';
  for (const phase of ['Running', 'Pending', 'Failed', 'Succeeded', 'Unknown'] as const) if (conditionWord(prompt, phase)) return phase;
  if (conditionWord(prompt, 'completed')) return 'Succeeded';
  return undefined;
}
export function normalizeIP(value: string): string | undefined {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value.split('.').every((part) => Number(part) <= 255 && String(Number(part)) === part) ? value : undefined;
  if (!/^[a-f\d:]+$/i.test(value) || !value.includes(':')) return undefined;
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return undefined; }
}

export function readExplorationQuestion(name: string, args: Record<string, unknown>, prompt: string): ClusterQuestion {
  const schema = EXPLORE_TOOLS.find((entry) => entry.name === name);
  if (!schema || Object.keys(args).some((key) => !(key in schema.parameters.properties)) || schema.parameters.required.some((key) => args[key] === undefined)) throw new Error('Unsupported arguments for this question.');
  const result: ClusterQuestion = { topic: name as ClusterQuestion['topic'] };
  for (const key of ['query', 'namespace', 'node', 'container'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !namePattern.test(value) || !literal(value, prompt) ||
      (['namespace', 'container'].includes(key) && !dnsLabel.test(value)) ||
      (key === 'query' && generic.test(value))) throw new Error('A selected filter was not clearly stated. Include a resource name, label or image.');
    result[key === 'query' ? 'name' : key] = value;
  }
  const ns = explicitNamespace(prompt);
  if (ns !== result.namespace) throw new Error('The model missed or changed the namespace in your question.');
  if (/\ball namespaces\b/i.test(prompt)) {
    if (ns) throw new Error('Name one namespace or ask across all namespaces.');
    result.allNamespaces = true;
  }
  const locatedNode = /\b(?:on|for|of)\s+(?:the\s+)?node\s+["']?([a-z0-9][-a-z0-9.]*)/i.exec(prompt)?.[1]?.replace(/\.$/, '');
  const directNode = /\bnode\s+["']?([a-z0-9][-a-z0-9.]*)/i.exec(prompt)?.[1]?.replace(/\.$/, '');
  const requestedNode = locatedNode ?? (directNode && !generic.test(directNode) && !/^(?:capacity|usage|resources|allocatable|name|cache)$/i.test(directNode) ? directNode : undefined);
  if (requestedNode && requestedNode !== result.node) throw new Error('The model missed the node filter.');
  if (result.node && !new RegExp(`\\bnode\\s+["']?${quote(result.node)}(?=$|[\\s"'.,!?])`, 'i').test(prompt)) throw new Error('Name the node explicitly.');
  if (['list_configmaps', 'list_secrets'].includes(name) && /\bsecrets?\b/i.test(prompt) && /\bconfig[ -]?maps?\b/i.test(prompt)) throw new Error('Ask for one resource inventory at a time.');
  if (['list_configmaps', 'list_secrets', 'list_images'].includes(name)) {
    const wanted = /\b(?:matching|named|called|containing)\s+["']?([a-z0-9][a-z0-9._/:=~-]*)/i.exec(prompt)?.[1]?.replace(/\.$/, '');
    if (wanted && result.name !== wanted) throw new Error('The model missed the resource filter.');
    if (result.name && [result.namespace, result.node].includes(result.name) && wanted !== result.name &&
        !new RegExp(`\\b(?:pod\\s+["']?${quote(result.name)}|${quote(result.name)}\\s+(?:pods?|secrets?|config[ -]?maps?|images?))\\b`, 'i').test(prompt)) throw new Error('The model confused a namespace or node with a resource filter.');
  }
  if (name === 'query_pods' || name === 'pod_logs') {
    const wanted = requestedPodQuery(prompt);
    if (result.name && [result.node, result.namespace, result.container].includes(result.name) && wanted !== result.name.toLowerCase()) throw new Error('The model confused the resource filter with a node, namespace or container.');
    if (wanted && wanted.toLowerCase() !== result.name?.toLowerCase()) throw new Error('The model missed the pod filter. Please include the name, label or image again.');
  }
  if (name === 'query_pods') {
    if (/\b(?:over|under|above|below|more than|less than|at least|at most)\s+\d|[<>]=?\s*\d|\bnot\s+(?:running|pending|failed|succeeded)\b|\bor\b/i.test(prompt)) throw new Error('This pod query supports one name/label/image match, one status, a node, a namespace and ordering. Numeric thresholds and OR/exclusion conditions are not supported here yet.');
    const sort = requestedSort(prompt);
    const status = requestedState(prompt);
    if (args.sort !== sort || args.status !== status) throw new Error('The model missed the requested pod status or ordering.');
    if (sort) result.sort = sort;
    if (status) result.status = status;
    const count = requestedCount(prompt);
    if (args.limit !== count || (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 20))) throw new Error('Request between 1 and 20 results; the model must preserve the count.');
    if (count !== undefined) result.limit = count;
  }
  if (name === 'pod_logs') {
    const previous = /\bprevious\b/i.test(prompt);
    if (args.previous !== undefined && typeof args.previous !== 'boolean') throw new Error('Invalid log selection.');
    if ((args.previous === true) !== previous) throw new Error('The model missed the previous log selection.');
    if (previous) result.previous = true;
    const container = /\bcontainer\s+["']?([a-z0-9][-a-z0-9]*)/i.exec(prompt)?.[1];
    if (container !== result.container) throw new Error('The model missed the container selection.');
  }
  if (name === 'lookup_ip' || name === 'lookup_port') {
    const candidates = explorationCandidates(prompt);
    if (candidates.includes('lookup_ip') && candidates.includes('lookup_port')) throw new Error('Ask about one IP address or one port at a time.');
    const kinds = [...prompt.matchAll(/\b(services?|pods?|nodes?|ingress(?:es)?|endpointslices?)\b/gi)].map((match) => {
      const kind = match[1]!.toLowerCase();
      return kind.startsWith('ingress') ? 'ingresses' : kind.endsWith('s') ? kind : kind + 's';
    });
    if (new Set(kinds).size > 1) throw new Error('Ask about one resource kind or ask for all IP/port references.');
    if (kinds[0]) result.networkKind = kinds[0] as ClusterQuestion['networkKind'];
    if (name === 'lookup_port' && result.networkKind === 'nodes') throw new Error('Node listening sockets are not available from Kubernetes object declarations. Ask for configured ports or Service nodePorts.');
    if (name === 'lookup_ip' && (prompt.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)?.length ?? 0) > 1) throw new Error('Ask about one IP address at a time.');
  }
  if (name === 'lookup_ip') {
    if (typeof args.ip !== 'string' || !literal(args.ip, prompt) || !normalizeIP(args.ip)) throw new Error('Include one valid IP address.');
    result.ip = args.ip;
  }
  if (name === 'lookup_port') {
    if (!Number.isInteger(args.port) || Number(args.port) < 1 || Number(args.port) > 65535 || !literal(String(args.port), prompt)) throw new Error('Include a port number between 1 and 65535.');
    result.port = Number(args.port);
    const protocol = /\b(TCP|UDP|SCTP)\b/i.exec(prompt)?.[1]?.toUpperCase();
    if (args.protocol !== protocol) throw new Error('The model missed the transport protocol.');
    if (protocol) result.protocol = protocol as ClusterQuestion['protocol'];
  }
  if (name === 'list_images') {
    const source = /\b(?:available|both)\b/i.test(prompt) ? 'both' : /\b(?:cached|cache|downloaded)\b/i.test(prompt) ? 'cached' : /\b(?:pods?|used|workloads?)\b/i.test(prompt) ? 'workloads' : /\b(?:on node|on the node)\b/i.test(prompt) ? 'cached' : 'workloads';
    if (args.source !== source) throw new Error('The model confused workload images and the node image cache.');
    if (ns && source !== 'workloads') throw new Error('Node image caches have no namespace. Ask for pod images in a namespace or cached images on a node.');
    result.source = source;
    if (source === 'workloads' && /\bpods?\b/i.test(prompt)) {
      const wanted = requestedPodQuery(prompt);
      if (wanted && wanted !== result.name?.toLowerCase()) throw new Error('The model missed the pod image filter.');
      if (wanted) result.imagePodQuery = true;
    }
  }
  return result;
}
