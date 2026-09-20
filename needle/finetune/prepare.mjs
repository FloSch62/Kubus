// Synthetic, reproducible pilot data. No cluster objects or external API calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { POD_FILTER_TOOLS, readPodFilterSuggestion } from '../../client/src/needle/pod-filter.ts';
import { evaluationCases } from './test-cases.mjs';

const destination = new URL('../../.cache/needle-training/data/', import.meta.url);
const examples = [];
const testQueries = new Set(evaluationCases.map(([query]) => query.toLowerCase()));
const seen = new Set(testQueries);
function example(query, args, reasoning) {
  return { query, tools: POD_FILTER_TOOLS, answers: args ? [{ name: 'filter_pods', arguments: args }] : [], reasoning };
}
function add(query, args, reasoning) {
  const key = query.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  examples.push(example(query, args, reasoning));
}
const statuses = {
  running: ['running pods', 'pods with status Running', 'pods in the Running phase'],
  pending: ['pending pods', 'pods with status Pending', 'pods in the Pending phase'],
  crash: ['crashing pods', 'pods in CrashLoopBackOff', 'crash-looping pods'],
  oom: ['OOMKilled pods', 'pods killed by the OOM killer', 'pods terminated because they ran out of memory'],
  error: ['pods with errors', 'failed pods', 'pods with error or backoff statuses'],
  unhealthy: ['unhealthy pods', 'pods that are unhealthy', 'pods with health problems'],
  healthy: ['healthy pods', 'pods that are healthy', 'pods that are fully healthy'],
  completed: ['completed pods', 'succeeded pods', 'pods that completed successfully'],
};
const namespaces = ['production', 'staging', 'kube-system', 'default', 'monitoring', 'team-a', 'dev', 'payments', 'qa-2', 'pods', 'running', 'healthy'];
const starts = ['Show', 'List', 'Find', 'Display', 'Filter for', 'Please show', 'I want to see', 'Can you list'];
for (const [status, phrases] of Object.entries(statuses)) {
  for (const phrase of phrases) {
    for (const start of starts) {
      add(`${start} ${phrase}`, { status }, `The request asks for ${status} pods and specifies no namespace.`);
      for (const namespace of namespaces) {
        // The two forms are both explicitly supported by the app's grounding check.
        const context = namespace.length % 2 ? `in ${namespace}` : `in namespace ${namespace}`;
        add(`${start} ${phrase} ${context}`, { namespace, status }, `${context} gives namespace ${namespace}; ${phrase} gives status ${status}.`);
      }
    }
  }
}
for (const namespace of namespaces) {
  for (const start of starts) {
    for (const query of [`${start} pods in namespace ${namespace}`, `${start} pods in ${namespace}`, `${start} pods in the ${namespace} namespace`]) {
      add(query, { namespace }, `The namespace is ${namespace}. No pod status is requested.`);
    }
  }
}
const unsupported = [
  'Delete all pods', 'Restart the pods', 'Scale the deployment to three replicas',
  'Show pod logs', 'Open a shell in a pod', 'Explain why the pods are crashing',
  'Show services', 'List deployments', 'Show nodes', 'Show secrets',
  'Show pods with more than 3 restarts', 'Show pods named api-server',
  'Show pods using more than 1GB of RAM', 'Show pods on node worker-1',
  'Show pods with label app=web', 'Show pods older than two hours',
  'Hide running pods', 'Show pods that are not running', 'Show running or pending pods',
  'Show pending pods and delete them', 'Show unhealthy pods with more than 5 restarts',
  'Show running pods named frontend', 'Show pods in production and staging',
  'Show pods in every namespace except kube-system',
];
for (const query of unsupported) {
  for (const suffix of ['', ...namespaces.slice(0, 8).map((ns) => ` in namespace ${ns}`)]) {
    add(query + suffix, null, 'This request includes an action or condition that the namespace/status filter cannot represent completely.');
  }
}
for (const query of ['Hello', 'Thanks', 'What is Kubernetes?', 'What time is it?', 'Tell me a joke', 'Show all pods', 'Show pods', 'Why is my cluster slow?', 'Generate a deployment YAML']) {
  for (const prefix of ['', 'Please: ', 'Help me: ']) add(prefix + query, null, 'No supported namespace or pod-status filter is requested.');
}

// Balance the sample, rather than letting the namespace Cartesian product dominate.
let state = 20260920;
function shuffle(rows) {
  const result = [...rows];
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
const combined = examples.filter((row) => row.answers[0]?.arguments.namespace && row.answers[0]?.arguments.status);
const statusOnly = examples.filter((row) => row.answers[0]?.arguments.status && !row.answers[0]?.arguments.namespace);
const namespaceOnly = examples.filter((row) => row.answers[0]?.arguments.namespace && !row.answers[0]?.arguments.status);
const refusals = examples.filter((row) => !row.answers.length);
const train = shuffle([...shuffle(combined).slice(0, 560), ...shuffle(statusOnly).slice(0, 180), ...shuffle(namespaceOnly).slice(0, 180), ...shuffle(refusals).slice(0, 220)]);
const test = evaluationCases.map(([query, args]) => example(query, args, ''));
for (const row of [...train, ...test]) {
  assert(row.query.length <= 300);
  if (row.answers.length) {
    readPodFilterSuggestion({ success: true, confidence: 1, function_calls: row.answers }, row.query);
  }
}
assert.equal(new Set([...train, ...test].map((row) => row.query.toLowerCase())).size, train.length + test.length);
await mkdir(destination, { recursive: true });
const manifest = { seed: 20260920, source: 'Synthetic templates and separately authored test cases; no private cluster data.', files: {} };
for (const [name, rows] of [['train', train], ['test', test]]) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(new URL(`${String(name)}.jsonl`, destination), body);
  manifest.files[name] = { count: rows.length, refusals: rows.filter((row) => !row.answers.length).length, sha256: createHash('sha256').update(body).digest('hex') };
}
await writeFile(new URL('tools.json', destination), JSON.stringify(POD_FILTER_TOOLS, null, 2) + '\n');
await writeFile(new URL('manifest.json', destination), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
