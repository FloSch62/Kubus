export const CLUSTER_TOPICS = ['overview', 'health', 'pods', 'nodes', 'deployments', 'services', 'storage', 'namespaces', 'events', 'restarts', 'cpu', 'memory', 'images'] as const;
export type ClusterTopic = typeof CLUSTER_TOPICS[number];
export interface ClusterQuestion {
  topic: ClusterTopic;
  namespace?: string;
  name?: string;
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
  if (result.topic === 'pods' && /\b(?:restart(?:s|ing)?|cpu|memory|ram|images?|unhealthy)\b/i.test(prompt)) {
    throw new Error('The model chose a general pod list for a more specific report. Try “Show pod restart counts”, “Show memory usage”, “Show pod images” or “Check cluster health”.');
  }
  // Fine-tuning does not calibrate the confidence head. Never use its score.
  return result;
}

export type ClusterWorkerResponse =
  | { type: 'status'; status: 'loading' | 'thinking' }
  | { type: 'question'; question: ClusterQuestion }
  | { type: 'error'; error: string };
