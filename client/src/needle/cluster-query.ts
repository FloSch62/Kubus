export const CLUSTER_TOPICS = ['overview', 'health', 'pods', 'nodes', 'deployments', 'services', 'storage', 'namespaces', 'events', 'restarts', 'cpu', 'memory', 'images'] as const;
export type ClusterTopic = typeof CLUSTER_TOPICS[number];
export interface ClusterQuestion {
  topic: ClusterTopic | 'find_pods' | 'latest_deployments' | 'summarize_events' | 'recent_terminations' | 'diagnose_pod';
  namespace?: string;
  name?: string;
  limit?: number;
  uid?: string;
  allNamespaces?: boolean;
}

export const CLUSTER_TOOLS = [{
  name: 'inspect_cluster',
  description: 'Read a Kubernetes cluster report.',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string', enum: [...CLUSTER_TOPICS],
        description: 'Report type.',
      },
      namespace: { type: 'string', description: 'Explicit namespace, if given.' },
      name: { type: 'string', description: 'Exact resource name, if given.' },
    },
    required: ['topic'],
  },
}];

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only a fixed read operation is returned; model text cannot become an API URL. */
export function readClusterQuestion(response: unknown, prompt: string): ClusterQuestion {
  const unsupported = 'I could not match that to a supported cluster question. Try health, resources, warnings, restarts, CPU, memory or images.';
  if (/(?:^|\b(?:and|then)\s+)(?:please\s+)?(?:delete|restart|scale|drain|cordon|uncordon|create|install|uninstall|apply|patch|upgrade|rollback|execute)\b/i.test(prompt.trim())) throw new Error(unsupported);
  if (!record(response) || response.success !== true || response.error || !Array.isArray(response.function_calls)) throw new Error(unsupported);
  // Needle's documented extract() path reads held calls as structured data.
  // For this read-only classifier, allow a single held record only when the
  // engine explicitly reports no grounding/negation issue. Never execute it.
  const held = Array.isArray(response.suppressed_calls) ? response.suppressed_calls : [];
  const extractingHeld = response.function_calls.length === 0 && held.length === 1;
  if (extractingHeld && (!record(response.validation) || response.validation.negation !== false ||
      !Array.isArray(response.validation.ungrounded) || response.validation.ungrounded.length !== 0)) throw new Error(unsupported);
  const calls = extractingHeld ? held : response.function_calls;
  if (calls.length !== 1 || (!extractingHeld && held.length > 0)) throw new Error(unsupported);
  if (record(response.validation) && (response.validation.negation === true ||
      (Array.isArray(response.validation.ungrounded) && response.validation.ungrounded.length))) throw new Error(unsupported);
  const call: unknown = calls[0];
  if (!record(call) || call.name !== 'inspect_cluster' || !record(call.arguments)) throw new Error(unsupported);
  const args = call.arguments;
  if (Object.keys(args).some((key) => !['topic', 'namespace', 'name'].includes(key)) ||
      typeof args.topic !== 'string' || !CLUSTER_TOPICS.includes(args.topic as ClusterTopic)) throw new Error(unsupported);
  const result: ClusterQuestion = { topic: args.topic as ClusterTopic };
  for (const key of ['namespace', 'name'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(value) ||
        (key === 'namespace' && (value.length > 63 || value.includes('.')))) throw new Error(unsupported);
    const escaped = value.replaceAll('.', '\\.');
    const evidence = key === 'namespace'
      ? new RegExp(`\\b(?:in|namespace)\\s+["']?${escaped}(?=$|[\\s"'.,!?])|\\b${escaped}\\s+namespace\\b`, 'i')
      : new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.[\\w.-])`, 'i');
    if (!evidence.test(prompt)) throw new Error('The model selected a name that was not clearly stated. Please name the resource or namespace explicitly.');
    result[key] = value;
  }
  if (result.namespace && ['nodes', 'namespaces'].includes(result.topic)) throw new Error('Nodes and namespaces are cluster-wide. Ask without a namespace condition.');
  if (result.name && ['overview', 'health', 'namespaces'].includes(result.topic)) throw new Error('Ask for a specific resource using pods, nodes, deployments or services.');
  // Grounding checks above catch invented values. Also reject dropped scope in
  // explicit forms; silently broadening a named question gives a wrong answer.
  const namespace = /\bin\s+namespace\s+["']?([a-z0-9][-a-z0-9]*)(?=$|[\s"'.,!?])/i.exec(prompt)?.[1];
  const namedPod = /\bfor\s+pod\s+["']?([a-z0-9][-a-z0-9.]*)(?=$|[\s"',!?])/i.exec(prompt)?.[1]?.replace(/\.$/, '');
  const direct = /\b(?:show|inspect|check)\s+(pod|node|deployment|service|pvc)\s+["']?([a-z0-9][-a-z0-9.]*)(?=$|[\s"',!?])/i.exec(prompt);
  // A digit, dot or hyphen distinguishes common resource identifiers from
  // phrases such as "show pod status" or "show service ports".
  const directName = direct?.[2] && /[-.0-9]/.test(direct[2]) ? direct[2].replace(/\.$/, '') : undefined;
  const name = namedPod ?? directName;
  if ((namespace && namespace.toLowerCase() !== result.namespace) || (name && name.toLowerCase() !== result.name)) {
    throw new Error('The model missed a resource name or namespace in your question. Please rephrase before requesting this report.');
  }
  const directTopics: Record<string, ClusterTopic> = { pod: 'pods', node: 'nodes', deployment: 'deployments', service: 'services', pvc: 'storage' };
  if (directName && result.topic !== directTopics[direct![1]!.toLowerCase()]) throw new Error(unsupported);
  if (result.topic === 'pods' && /\b(?:restart(?:s|ing|ed)?|cpu|processor|memory|ram|images?|unhealthy)\b/i.test(prompt)) {
    throw new Error('The model chose a general pod list for a more specific report. Try “Show pod restart counts”, “Show memory usage”, “Show pod images” or “Check cluster health”.');
  }
  // Fine-tuning does not calibrate the confidence head. Never use its score.
  return result;
}

export type ClusterWorkerResponse =
  | { type: 'status'; status: 'loading' | 'thinking' }
  | { type: 'question'; question: ClusterQuestion }
  | { type: 'error'; error: string };


const namespace = { type: 'string', maxLength: 63, description: 'Explicit namespace, if given.' };
const query = { type: 'string', minLength: 1, maxLength: 253, description: 'Pod name or search text explicitly stated in the question.' };
const limit = { type: 'integer', minimum: 1, maximum: 20, description: 'Number of records explicitly requested.' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
});
export const HARNESS_TOOLS = [
  ...CLUSTER_TOOLS,
  tool('find_pods', 'Find pods and their namespaces by name, label or container image.', { query, namespace }, ['query']),
  tool('latest_deployments', 'Show the newest created Deployments.', { namespace, limit }),
  tool('summarize_events', 'Summarize the latest Kubernetes events, including Normal and Warning.', { namespace, limit }),
  tool('recent_terminations', 'Find the latest recorded failed pod container terminations and when they died.', { namespace, limit }),
  tool('diagnose_pod', 'Explain why a named pod is failing using status, events and logs.', { query, namespace }, ['query']),
];

/** Explicit, high-recall shortlist: the shipped archive has no trained retrieval head. */
export function toolsForQuestion(prompt: string) {
  const candidates = new Set(['inspect_cluster']);
  if (/\b(?:find|locate|where|which namespace|in which|search)\b/i.test(prompt)) candidates.add('find_pods');
  if (/\b(?:deployments?|deployed|rollouts?)\b/i.test(prompt)) candidates.add('latest_deployments');
  if (/\b(?:events?|happened|happening)\b/i.test(prompt)) candidates.add('summarize_events');
  if (/\b(?:died|die|dead|death|killed|terminated|terminations?|crashed|crash|last.*fail)\b/i.test(prompt)) candidates.add('recent_terminations');
  if (/\b(?:why|diagnos\w*|debug|troubleshoot|failing|broken|stuck|crash\w*|not running|won't start)\b/i.test(prompt)) candidates.add('diagnose_pod');
  return HARNESS_TOOLS.filter((entry) => candidates.has(entry.name)).slice(0, 5);
}

/** One retry for an empty classification with exactly one task candidate.
 * Never retry held calls, grounding/negation failures or multiple candidates.
 * The second pass still selects a call normally and passes the same validator.
 */
export function retryToolsForQuestion(response: unknown, prompt: string) {
  if (!record(response) || response.success !== true || response.error ||
      !Array.isArray(response.function_calls) || response.function_calls.length ||
      (Array.isArray(response.suppressed_calls) && response.suppressed_calls.length) ||
      (record(response.validation) && (response.validation.negation === true ||
        (Array.isArray(response.validation.ungrounded) && response.validation.ungrounded.length)))) return [];
  const candidates = toolsForQuestion(prompt).filter((entry) => entry.name !== 'inspect_cluster');
  return candidates.length === 1 ? candidates : [];
}

const unsupported = 'I could not match that to a supported cluster question. Try finding a pod, recent terminations, latest deployments, events or pod diagnosis.';

export function readHarnessQuestion(response: unknown, prompt: string): ClusterQuestion {
  // These boundaries also protect against a model dropping a requested action,
  // time condition or count. They never manufacture an alternative model call.
  if (/(?<![\w.-])(?:delete|scale|drain|cordon|uncordon|create|install|uninstall|apply|patch|upgrade|rollback|execute|passwords?|secrets?|tokens?|kubeconfig|fix)(?![\w.-])/i.test(prompt) ||
      /\b(?:restart|reboot)\s+(?:the\s+|all\s+|my\s+)?(?:pods?|deployments?|it|them)\b/i.test(prompt) ||
      /(?<![\w.-])(?:yesterday|today|ago|last (?:week|month|year)|tomorrow|since|between|before|after|past \d+|last \d+ (?:minutes?|hours?|days?))(?![\w.-])/i.test(prompt) ||
      /\bin\s+(?:namespace\s+)?[a-z0-9-]+\s+(?:or|and)\s+[a-z0-9-]+\b/i.test(prompt) ||
      /\benvironment\s+variables\b/i.test(prompt) ||
      /\b(?:don't|do not|never)\b/i.test(prompt)) throw new Error(unsupported);
  if (/\b(?:latest|last|newest|recent)\b.*\brollout\b|\brollout\b.*\b(?:latest|last|newest)\b/i.test(prompt) ||
      (/\bdeployments?\b/i.test(prompt) && /\b(?:updated|modified|rolled out)\b/i.test(prompt))) {
    throw new Error('Newest Deployment means creation time. The latest rollout time cannot be reliably reconstructed from retained ReplicaSets. Ask for the latest deployment or open its rollout history in Kubus.');
  }
  if (/\band\s+(?:then\s+)?(?:find|locate|summarize|summarise|diagnose|debug|troubleshoot|show|list|inspect)\b/i.test(prompt)) throw new Error('Ask for one workflow at a time, then use a follow-up question.');
  if (!record(response) || response.success !== true || response.error || !Array.isArray(response.function_calls)) throw new Error(unsupported);
  const held = Array.isArray(response.suppressed_calls) ? response.suppressed_calls : [];
  const extracting = response.function_calls.length === 0 && held.length === 1;
  if (extracting && (!record(response.validation) || response.validation.negation !== false ||
      !Array.isArray(response.validation.ungrounded) || response.validation.ungrounded.length)) throw new Error(unsupported);
  const calls = extracting ? held : response.function_calls;
  if (calls.length !== 1 || (!extracting && held.length) || (record(response.validation) &&
      (response.validation.negation === true || (Array.isArray(response.validation.ungrounded) && response.validation.ungrounded.length)))) throw new Error(unsupported);
  const call = calls[0];
  if (!record(call) || !record(call.arguments) || !toolsForQuestion(prompt).some((entry) => entry.name === call.name)) throw new Error(unsupported);
  if ((/(?<![\w.-])(?:why|diagnose|debug|troubleshoot)(?![\w.-])/i.test(prompt) && call.name !== 'diagnose_pod') ||
      (/(?<![\w.-])(?:where|locate|which namespace)(?![\w.-])/i.test(prompt) && call.name !== 'find_pods') ||
      (/\b(?:on node|on the node)\b/i.test(prompt))) throw new Error('The model missed the specific workflow or a condition. Please rephrase.');
  const allNamespaces = /\ball namespaces\b/i.test(prompt) && !/\blist all namespaces\b/i.test(prompt);
  if (call.name === 'inspect_cluster') {
    if (/\b(?:with|have|having)\s+(?:the\s+)?label\b/i.test(prompt)) throw new Error('Use “Find pods matching app=web” to search by a label.');
    if ((/\bdeployments?\b/i.test(prompt) && /\b(?:latest|newest|most recently|last)\b/i.test(prompt)) ||
        (/\bevents\b/i.test(prompt) && !/\b(?:warning|warnings|problems)\b/i.test(prompt)) ||
        /\b(?:died|death|terminat\w*)\b|\b(?:why|where|locate|diagnose|troubleshoot)\b|\b(?:last|latest)\s+\d+\s+(?:warning\s+)?events\b/i.test(prompt)) throw new Error('The model missed the specific workflow. Try one of the example questions.');
    const question = readClusterQuestion(response, prompt);
    return allNamespaces ? { ...question, allNamespaces: true } : question;
  }
  const args = call.arguments;
  const named = call.name === 'find_pods' || call.name === 'diagnose_pod';
  if (Object.keys(args).some((key) => !['namespace', named ? 'query' : 'limit'].includes(key))) throw new Error(unsupported);
  const result: ClusterQuestion = { topic: call.name as ClusterQuestion['topic'] };
  if (allNamespaces) result.allNamespaces = true;
  for (const key of ['namespace', 'query'] as const) {
    const value = args[key];
    if (value === undefined) { if (key === 'query' && named) throw new Error(unsupported); continue; }
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._/=:~-]{0,252}$/i.test(value)) throw new Error(unsupported);
    if (key === 'query' && /^(?:pod|pods|namespace|my|it|why|failing|broken|stuck)$/i.test(value)) throw new Error('Include a pod name, label or image to search for.');
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const evidence = key === 'namespace'
      ? new RegExp(`\\b(?:in|namespace)\\s+["']?${escaped}(?=$|[\\s"'.,!?])|\\b${escaped}\\s+namespace\\b`, 'i')
      : new RegExp(`(?<![\\w./:=~-])${escaped}(?![\\w/:=~-]|\\.[\\w.-])`, 'i');
    if (!evidence.test(prompt) || (key === 'namespace' && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))) throw new Error('The model selected a name that was not clearly stated. Please name the pod or namespace explicitly.');
    if (key === 'namespace') result.namespace = value;
    else result.name = value;
  }
  const explicitNamespaces = [...prompt.matchAll(/\bin\s+(?:namespace\s+)?["']?([a-z0-9][-a-z0-9]*)(?=$|[\s"'.,!?])/gi)]
    .map((match) => match[1]!.toLowerCase()).filter((value) => !['which', 'my', 'the', 'this', 'all', 'kubus'].includes(value));
  if (new Set(explicitNamespaces).size > 1) throw new Error('Name one namespace or ask across all namespaces.');
  if (explicitNamespaces.some((value) => value !== result.namespace)) throw new Error('The model missed the namespace in your question.');
  const count = /\b(?:last|latest|newest|recent|show|summarize|summarise)\s+(\d+|one|two|three|five|ten|twenty)\b/i.exec(prompt)?.[1]?.toLowerCase();
  const words: Record<string, number> = { one: 1, two: 2, three: 3, five: 5, ten: 10, twenty: 20 };
  const requested = count ? words[count] ?? Number(count) : undefined;
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20 || args.limit !== requested) throw new Error('Request between 1 and 20 records and include that number in the question.');
    result.limit = Number(args.limit);
  }
  if (!named && requested !== undefined && result.limit !== requested) throw new Error('The model missed the requested number of records. Please rephrase.');
  return result;
}
