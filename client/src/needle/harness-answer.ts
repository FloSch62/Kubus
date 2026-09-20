import { eventTimestamp, failedPodTerminations, type KubeObject, type ListResponse, type PodTerminationHistory } from '@kubus/shared';
import { podSummary } from '../kube-display.js';
import type { ClusterQuestion } from './cluster-query.js';
import type { ClusterAnswer, PodChoice, QuestionScope } from './cluster-answer.js';

type Reader = <T>(path: string, init?: RequestInit) => Promise<T>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
const stamp = (value: string | undefined) => Date.parse(value ?? '') || 0;
const identity = (pod: KubeObject): PodChoice => ({ name: pod.metadata.name, namespace: pod.metadata.namespace ?? '', uid: pod.metadata.uid });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function podMatch(pod: KubeObject, query: string): string[] {
  const needle = query.toLowerCase();
  const evidence: string[] = [];
  if (query.includes('=')) {
    const [key, ...rest] = query.split('=');
    const value = rest.join('=');
    return key && pod.metadata.labels?.[key] === value ? [`label: ${key}=${value}`] : [];
  }
  if (pod.metadata.name.toLowerCase().includes(needle)) evidence.push(`name: ${pod.metadata.name}`);
  for (const [key, value] of Object.entries(pod.metadata.labels ?? {})) {
    if (`${key}=${value}`.toLowerCase().includes(needle)) evidence.push(`label: ${key}=${value}`);
  }
  for (const container of [...list(pod.spec?.containers), ...list(pod.spec?.initContainers)]) {
    if (text(container.image).toLowerCase().includes(needle)) evidence.push(`image: ${text(container.image)}`);
  }
  return evidence;
}

/** Bounded read workflows. Model output selects a workflow; it never supplies a URL. */
export async function answerHarnessQuestion(question: ClusterQuestion, inputScope: QuestionScope, signal: AbortSignal, read: Reader): Promise<ClusterAnswer> {
  const scope = { context: inputScope.context, namespaces: question.namespace ? [question.namespace] : question.topic === 'find_pods' ? [] : [...inputScope.namespaces] };
  if (question.allNamespaces && !question.namespace) scope.namespaces = [];
  if (!scope.context) throw new Error('Select a connected cluster first.');
  const answer: ClusterAnswer = { scope, question, fetchedAt: '', sections: [], notices: [] };
  const base = `/api/contexts/${encodeURIComponent(scope.context)}`;
  const limit = question.limit ?? (question.topic === 'summarize_events' ? 10 : 1);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Request between 1 and 20 records.');
  const get = async <T>(path: string): Promise<T> => { signal.throwIfAborted(); return read<T>(`${base}${path}`, { signal }); };
  let requests = 0;
  async function objects(plural: 'pods' | 'deployments' | 'events', namespaces = scope.namespaces, fieldSelector?: string): Promise<KubeObject[]> {
    const result: KubeObject[] = [];
    // A single total cap covers all selected namespaces, not 10k per namespace.
    for (const namespace of namespaces.length ? namespaces : ['']) {
      let continuation = '';
      const seen = new Set<string>();
      do {
        if (++requests > 40) throw new Error('This question exceeds the read budget. Select fewer namespaces.');
        const params = new URLSearchParams({ limit: '1000' });
        if (namespace) params.set('namespace', namespace);
        if (continuation) params.set('continue', continuation);
        if (fieldSelector) params.set('fieldSelector', fieldSelector);
        const page = await get<ListResponse>(`/resources/${plural === 'deployments' ? 'apps' : 'core'}/v1/${plural}?${params}`);
        if (!Array.isArray(page.items)) throw new Error(`Invalid ${plural} response.`);
        result.push(...page.items.filter((item) => !namespace || item.metadata.namespace === namespace));
        continuation = page.continue ?? '';
        if (result.length > 10_000 || (continuation && (result.length >= 10_000 || seen.has(continuation)))) throw new Error('Too many records for this question. Select a narrower namespace scope.');
        seen.add(continuation);
      } while (continuation);
    }
    return [...new Map(result.map((item) => [item.metadata.uid || `${item.metadata.namespace}/${item.metadata.name}`, item])).values()];
  }
  function href(plural: 'pods' | 'deployments', obj: KubeObject) {
    return `/r/${plural === 'deployments' ? 'apps' : 'core'}/v1/${plural}?${new URLSearchParams({ sel: `${scope.context}|${obj.metadata.namespace ?? ''}|${obj.metadata.name}` })}`;
  }
  function eventSection(events: KubeObject[], count: number) {
    const undated = events.filter((event) => !stamp(eventTimestamp(event))).length;
    const selected = events.filter((event) => stamp(eventTimestamp(event))).sort((a, b) => stamp(eventTimestamp(b)) - stamp(eventTimestamp(a))).slice(0, count);
    const warnings = selected.filter((event) => event.type === 'Warning').length;
    const reasons = [...new Set(selected.map((event) => text(event.reason)))].join(', ');
    answer.sections.push({ title: 'Latest events', summary: `${selected.length} latest dated event records: ${warnings} Warning, ${selected.length - warnings} other. ${reasons ? `Reasons: ${reasons}.` : 'No retained dated events found.'}`,
      columns: ['Namespace', 'Resource', 'Type', 'Reason', 'Message', 'Occurrences', 'Last observed'], rows: selected.map((event) => [
        event.metadata.namespace ?? '—', `${text(record(event.involvedObject).kind)} ${text(record(event.involvedObject).name)}`, text(event.type), text(event.reason), text(event.message), text(record(event.series).count ?? event.count ?? 1), eventTimestamp(event),
      ]), href: '/events' });
    answer.notices.push('Events have limited retention and are best-effort reports. Repeated events form one record; occurrence counts cover that record’s lifetime.');
    if (undated) answer.notices.push(`${undated} event records have no usable timestamp and cannot be ranked as latest.`);
  }

  if (question.topic === 'latest_deployments') {
    const all = await objects('deployments');
    const items = all.filter((obj) => stamp(obj.metadata.creationTimestamp)).sort((a, b) => stamp(b.metadata.creationTimestamp) - stamp(a.metadata.creationTimestamp)).slice(0, limit);
    answer.sections.push({ title: 'Latest deployments', summary: `${items.length} newest created Deployments in this scope.`,
      columns: ['Namespace', 'Deployment', 'Created', 'Ready / desired', 'Images'], rows: items.map((obj) => [obj.metadata.namespace ?? '—', obj.metadata.name, obj.metadata.creationTimestamp!,
        `${text(obj.status?.readyReplicas ?? 0)} / ${text(obj.spec?.replicas ?? 1)}`, list(record(record(obj.spec?.template).spec).containers).map((container) => text(container.image)).join(', ')]),
      rowLinks: items.map((obj) => href('deployments', obj)), href: '/r/apps/v1/deployments' });
    answer.notices.push('Sorted by Deployment creation time. Updating an existing Deployment, scaling it, or rolling back does not make it a newly created Deployment.');
    if (items.length < Math.min(limit, all.length)) answer.notices.push('Deployments without a usable creation timestamp could not be ranked.');
  } else if (question.topic === 'summarize_events') {
    eventSection(await objects('events'), limit);
  } else if (question.topic === 'recent_terminations') {
    const pods = await objects('pods');
    const now = new Date().toISOString();
    const entries = pods.flatMap((pod) => failedPodTerminations(pod, now));
    for (const namespace of scope.namespaces.length ? scope.namespaces : ['']) {
      try {
        const history = await get<PodTerminationHistory>(`/observations/terminations${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`);
        entries.push(...history.items.filter((entry) => !namespace || entry.namespace === namespace));
        answer.notices.push(`Observation journal${namespace ? ` (${namespace})` : ''} started ${history.startedAt}; watcher ${history.state}${history.interrupted ? ', connection gaps occurred' : ''}. ${history.evicted} records expired or exceeded capacity.`);
      } catch (error) { signal.throwIfAborted(); answer.notices.push(`Termination history unavailable: ${message(error)}. Using current pod status.`); }
    }
    const items = [...new Map(entries.map((entry) => [`${entry.uid}/${entry.container}/${entry.finishedAt}`, entry])).values()]
      .sort((a, b) => stamp(b.finishedAt) - stamp(a.finishedAt)).slice(0, limit);
    answer.sections.push({ title: 'Latest recorded failed container terminations', summary: items.length ? `${items.length} latest recorded failures. The most recent finished at ${items[0]!.finishedAt}.` : 'No dated failed container termination was found in the available observations.',
      columns: ['Namespace', 'Pod', 'Container', 'Finished', 'Reason', 'Exit code', 'Pod UID'], rows: items.map((entry) => [entry.namespace, entry.name, entry.container, entry.finishedAt, entry.reason, String(entry.exitCode), entry.uid]), href: '/r/core/v1/pods' });
    answer.notices.push('“Died” means a container terminated with a nonzero exit code, including init containers. Successful completion and pod deletion are different events. This does not prove which failure was last across unobserved periods.');
    answer.notices.push('The in-memory journal retains up to 10,000 observations for 24 hours after observation, only while Kubus is connected. Disconnecting the cluster or restarting Kubus clears it. Pod status exposes only current and last container terminations.');
  } else {
    if (!question.name) throw new Error('Include a pod name, label or image to search for.');
    const all = await objects('pods', scope.namespaces, question.uid ? `metadata.name=${question.name}` : undefined);
    const exact = all.filter((pod) => pod.metadata.name === question.name);
    const matches = (exact.length ? exact : all.filter((pod) => podMatch(pod, question.name!).length))
      .sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`));
    if (question.uid && !matches.some((pod) => pod.metadata.uid === question.uid)) throw new Error('The selected pod disappeared or was replaced. Search again to choose its current identity.');
    const candidates = question.uid ? matches.filter((pod) => pod.metadata.uid === question.uid) : matches;
    if (question.topic === 'find_pods' || candidates.length !== 1) {
      const shown = candidates.slice(0, 20);
      answer.sections.push({ title: 'Matching pods', summary: `${candidates.length} pods match “${question.name}”.${['diagnose_pod', 'pod_logs'].includes(question.topic) && candidates.length > 1 ? (question.topic === 'pod_logs' ? ' Choose the pod whose logs to read.' : ' Choose the pod to diagnose.') : ''}`,
        columns: ['Namespace', 'Pod', 'Status', 'Matched evidence'], rows: shown.map((pod) => [pod.metadata.namespace ?? '—', pod.metadata.name, podSummary(pod).status, podMatch(pod, question.name!).join('; ')]), rowLinks: shown.map((pod) => href('pods', pod)), rowPods: shown.map(identity), href: '/r/core/v1/pods' });
      answer.candidates = shown.map(identity);
      if (candidates.length === 1) answer.focus = identity(candidates[0]!);
      if (!question.namespace && question.topic === 'find_pods') answer.notices.push('Pod location searches cover all namespaces in the selected cluster. Name an explicit namespace to narrow the search.');
      if (candidates.length > 20) answer.notices.push('Showing the first 20 matches. Refine the name or namespace before choosing a pod.');
    } else {
      const selected = candidates[0]!;
      // Refresh exact identity before diagnosis; names may have been reused.
      const pod = await get<KubeObject>(`/resources/core/v1/pods/${encodeURIComponent(selected.metadata.name)}?${new URLSearchParams({ namespace: selected.metadata.namespace ?? '' })}`);
      if (pod.metadata.uid !== selected.metadata.uid) throw new Error('Pod was replaced during lookup. Ask again.');
      answer.focus = identity(pod);
      if (question.topic === 'pod_logs') {
        const containers = [...list(pod.spec?.containers), ...list(pod.spec?.initContainers), ...list(pod.spec?.ephemeralContainers)];
        const regular = list(pod.spec?.containers);
        const annotated = pod.metadata.annotations?.['kubectl.kubernetes.io/default-container'];
        const selectedContainer = question.container ?? (regular.some((entry) => entry.name === annotated) ? annotated : regular.length === 1 ? text(regular[0]!.name) : undefined);
        if (selectedContainer && !containers.some((entry) => entry.name === selectedContainer)) throw new Error(`Container ${selectedContainer} is not part of this pod.`);
        if (!selectedContainer) {
          answer.sections.push({ title: `Logs: ${pod.metadata.name}`, summary: 'Choose a container to read its logs.', columns: ['Container', 'Image'], rows: containers.map((entry) => [text(entry.name), text(entry.image)]) });
          answer.containers = containers.map((entry) => ({ pod: identity(pod), name: text(entry.name) }));
        } else {
          const params = new URLSearchParams({ namespace: pod.metadata.namespace ?? '', name: pod.metadata.name, uid: pod.metadata.uid, container: selectedContainer, previous: String(question.previous === true) });
          const logs = await get<{ uid: string; text: string; truncated: boolean }>(`/detail/pod-logs?${params}`);
          if (logs.uid !== pod.metadata.uid) throw new Error('Log identity does not match the selected pod.');
          answer.sections.push({ title: `${question.previous ? 'Previous' : 'Current'} logs: ${pod.metadata.name} / ${selectedContainer}`, summary: 'Last retained log excerpt, up to 80 lines / 16 KiB. Open the pod in Kubus for the full log viewer.', columns: [], rows: [], text: logs.text.slice(0, 16384) || '(No log output retained.)', href: href('pods', pod) });
          if (logs.truncated) answer.notices.push('The log excerpt reached its byte limit.');
        }
        signal.throwIfAborted();
        answer.fetchedAt = new Date().toISOString();
        return answer;
      }
      const statuses = [...list(pod.status?.initContainerStatuses), ...list(pod.status?.containerStatuses)];
      const findings: string[][] = [];
      if (pod.status?.reason || pod.status?.message) findings.push(['Pod status', text(pod.status.reason), text(pod.status.message)]);
      for (const container of statuses) {
        const waiting = record(record(container.state).waiting);
        const ended = record(record(container.state).terminated ?? record(container.lastState).terminated);
        if (waiting.reason) findings.push([`Container ${text(container.name)}`, text(waiting.reason), text(waiting.message)]);
        if (ended.reason && ended.exitCode !== 0) findings.push([`Last termination of ${text(container.name)}`, `${text(ended.reason)} (exit ${text(ended.exitCode)})`, `${text(ended.finishedAt)}${ended.message ? `: ${text(ended.message)}` : ''}`]);
      }
      for (const condition of list(pod.status?.conditions)) {
        if (condition.status === 'False') findings.push([`Condition ${text(condition.type)}`, text(condition.reason), text(condition.message)]);
      }
      // Earlier failures on a recovered container are evidence, but must not
      // become the explanation for a different current readiness problem.
      const reasons = new Set(list(pod.status?.conditions).filter((condition) => condition.status === 'False').map((condition) => text(condition.reason)));
      for (const container of statuses) {
        const state = record(container.state);
        if (record(state.waiting).reason) reasons.add(text(record(state.waiting).reason));
        if (record(state.terminated).exitCode !== 0 && record(state.terminated).reason) reasons.add(text(record(state.terminated).reason));
        if (record(state.waiting).reason === 'CrashLoopBackOff') reasons.add(text(record(record(container.lastState).terminated).reason));
      }
      const activeFailure = pod.status?.phase === 'Failed' || list(pod.status?.conditions).some((condition) => condition.status === 'False') || statuses.some((container) => {
        const state = record(container.state);
        return !!record(state.waiting).reason || (state.terminated && record(state.terminated).exitCode !== 0) || (state.running && container.ready === false);
      });
      const explanation = pod.status?.phase === 'Succeeded' ? 'This pod completed successfully. Kubernetes reports Succeeded; completion is not a pod failure. Earlier terminations, if shown, are historical evidence.' :
        pod.status?.phase === 'Unknown' ? 'The pod phase is Unknown. Its current condition cannot be established from pod status; inspect the reported evidence below.' :
        !activeFailure && findings.length ? 'Current pod status reports no active failure. Earlier container terminations below are historical evidence, not proof of a current failure.' :
        reasons.has('ImagePullBackOff') || reasons.has('ErrImagePull') ? 'The container image could not be pulled. The reported message below may identify an image, authentication or registry problem.' :
        reasons.has('Unschedulable') ? 'The scheduler reports that this pod cannot be placed. Its condition message explains the reported constraint.' :
        [...reasons].some((reason) => reason?.startsWith('OOMKilled')) ? 'Kubernetes reports an OOM kill. Check the container memory limit and memory usage; these observations do not identify an application memory leak.' :
        reasons.has('CrashLoopBackOff') ? 'The container repeatedly exits and Kubernetes is delaying another restart. CrashLoopBackOff describes the retry state; inspect the termination and logs below for the cause.' :
        findings.length ? 'Kubernetes reports the conditions below. They may explain the immediate failure; the underlying application cause may require further investigation.' :
        pod.status?.phase === 'Failed' ? 'Kubernetes marks this pod Failed but supplies no detailed cause in its current status. Related events and logs may explain it.' :
        'No failure reason is reported in the current pod status. This does not prove the application is healthy.';
      answer.sections.push({ title: `Pod diagnosis: ${pod.metadata.name}`, summary: explanation, columns: ['Evidence source', 'Reason', 'Details'], rows: findings,
        href: href('pods', pod) });
      answer.notices.push(`Resolved pod ${pod.metadata.namespace}/${pod.metadata.name}, UID ${pod.metadata.uid}; observed status ${podSummary(pod).status}.`);
      try {
        const events = await objects('events', [pod.metadata.namespace ?? ''], `involvedObject.uid=${pod.metadata.uid}`);
        eventSection(events.filter((event) => record(event.involvedObject).uid === pod.metadata.uid), 10);
      } catch (error) { signal.throwIfAborted(); answer.notices.push(`Pod events unavailable: ${message(error)}`); }
      const failing = statuses.filter((container) => {
        const state = record(container.state);
        if (record(state.terminated).exitCode === 0) return false;
        return container.ready !== true && (record(container.lastState).terminated || state.terminated || state.running);
      });
      for (const container of failing.slice(0, 2)) {
        const previous = !!record(container.lastState).terminated && Number(container.restartCount) > 0;
        try {
          const params = new URLSearchParams({ namespace: pod.metadata.namespace ?? '', name: pod.metadata.name, uid: pod.metadata.uid, container: text(container.name), previous: String(previous) });
          const logs = await get<{ uid: string; text: string; truncated: boolean }>(`/detail/pod-logs?${params}`);
          if (logs.uid !== pod.metadata.uid) throw new Error('Log identity does not match the selected pod.');
          answer.sections.push({ title: `${previous ? 'Previous' : 'Current'} logs: ${text(container.name)}`, summary: 'Evidence excerpt: up to 80 lines / 16 KiB. Log text is displayed verbatim; it is not treated as instructions or a verified explanation.', columns: [], rows: [], text: logs.text.slice(0, 16384) || '(No log output retained.)', href: href('pods', pod) });
          if (logs.truncated) answer.notices.push(`Log excerpt for ${text(container.name)} reached its byte limit.`);
        } catch (error) { signal.throwIfAborted(); answer.notices.push(`Logs for ${text(container.name)} unavailable: ${message(error)}`); }
      }
      if (failing.length > 2) answer.notices.push('Log reads are limited to two failing containers. Open the pod in Kubus to inspect the others.');
    }
  }
  signal.throwIfAborted();
  answer.fetchedAt = new Date().toISOString();
  return answer;
}
