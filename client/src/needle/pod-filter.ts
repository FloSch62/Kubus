// Keep the schema deliberately small: the base model confuses pod names with
// namespaces and strict/inclusive restart comparisons in broader schemas.
export const POD_FILTER_TOOLS = [{
  name: 'filter_pods',
  description: 'Show Kubernetes pods by namespace and health status.',
  parameters: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace to search, e.g. production.' },
      status: {
        type: 'string',
        enum: ['running', 'pending', 'crash', 'oom', 'error', 'unhealthy', 'healthy', 'completed'],
        description: 'crash means crashing or CrashLoopBackOff; oom means OOMKilled.',
      },
    },
    required: [],
  },
}];

const STATUS_LABELS: Record<string, string> = {
  running: 'Running', pending: 'Pending', crash: 'CrashLoopBackOff', oom: 'OOMKilled',
  error: 'Errors, failures or backoffs', unhealthy: 'Not fully healthy', healthy: 'Healthy', completed: 'Completed',
};

export interface PodFilterSuggestion {
  filter: string;
  description: string;
  confidence: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Treat the model response as untrusted data, never executable tool calls. */
export function readPodFilterSuggestion(response: unknown, prompt: string): PodFilterSuggestion {
  const unsupported = 'No supported filter found. Try a namespace and a pod status, like “Show crashing pods in production”.';
  if (!record(response) || response.success !== true || response.error ||
      !Array.isArray(response.function_calls) || response.function_calls.length !== 1 ||
      (Array.isArray(response.suppressed_calls) && response.suppressed_calls.length > 0)) {
    throw new Error(unsupported);
  }
  if (record(response.validation) && (response.validation.negation === true ||
      (Array.isArray(response.validation.ungrounded) && response.validation.ungrounded.length > 0))) {
    throw new Error(unsupported);
  }
  const confidence = response.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0.4 || confidence > 1) {
    throw new Error('Needle is unsure about this filter. Try a more specific namespace or status.');
  }
  const call: unknown = response.function_calls[0];
  if (!record(call) || call.name !== 'filter_pods' || !record(call.arguments)) throw new Error(unsupported);
  const args = call.arguments;
  if (Object.keys(args).some((key) => key !== 'namespace' && key !== 'status')) throw new Error(unsupported);
  const clauses: string[] = [];
  const descriptions: string[] = [];
  if (args.namespace !== undefined) {
    const namespace = args.namespace;
    // Also prevents smart-filter syntax from being injected through a value.
    if (typeof namespace !== 'string' || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)) throw new Error(unsupported);
    // The base model can call the word "pods" a namespace at confidence 0.99.
    // Require explicit namespace context, not merely a matching input token.
    // This checks the model's answer; it never invents or repairs an answer.
    const namespaceEvidence = new RegExp(`\\b(?:in|namespace)\\s+["']?${namespace}(?=$|[\\s"'.,!?])|\\b${namespace}\\s+namespace\\b`, 'i');
    if (!namespaceEvidence.test(prompt)) throw new Error(unsupported);
    clauses.push(`ns:${namespace}`);
    descriptions.push(`Namespace contains “${namespace}”`);
  }
  if (args.status !== undefined) {
    if (typeof args.status !== 'string' || !Object.hasOwn(STATUS_LABELS, args.status)) throw new Error(unsupported);
    clauses.push(`status:${args.status}`);
    descriptions.push(`Status: ${STATUS_LABELS[args.status]}`);
  }
  if (!clauses.length) throw new Error(unsupported);
  return { filter: `/${clauses.join(' ')}`, description: descriptions.join(' · '), confidence };
}

export type NeedleWorkerResponse =
  | { type: 'status'; status: 'loading' | 'thinking' }
  | { type: 'result'; result: PodFilterSuggestion; elapsedMs: number }
  | { type: 'error'; error: string };
