// Frozen before inspecting the new model. Do not fold these into training.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const { toolsForQuestion, readHarnessQuestion } = await import('./harness-v2-contract.mts');
const destination = new URL('../../.cache/needle-training/harness/', import.meta.url);
const cases = [
  ['Where is the eos-device pod located?', 'find_pods', { query: 'eos-device' }],
  ['Locate the route-reflector pod', 'find_pods', { query: 'route-reflector' }],
  ['Find pods matching sonic:2026.09', 'find_pods', { query: 'sonic:2026.09' }],
  ['Which namespace contains pod core-rtr-916?', 'find_pods', { query: 'core-rtr-916' }],
  ['Search pods for app=telemetry in namespace observability-v3', 'find_pods', { query: 'app=telemetry', namespace: 'observability-v3' }],
  ['Where is my nginx pod in namespace edge-west?', 'find_pods', { query: 'nginx', namespace: 'edge-west' }],
  ['Why is the pod checkout-98 stuck?', 'diagnose_pod', { query: 'checkout-98' }],
  ['Troubleshoot pod collector-729 in namespace observability-v3', 'diagnose_pod', { query: 'collector-729', namespace: 'observability-v3' }],
  ['Why is pod billing-3 not running?', 'diagnose_pod', { query: 'billing-3' }],
  ['Debug collector-729', 'diagnose_pod', { query: 'collector-729' }],
  ['Why does gateway-84 keep crashing in namespace edge-west?', 'diagnose_pod', { query: 'gateway-84', namespace: 'edge-west' }],
  ['Diagnose my ceos-lab-99 pod', 'diagnose_pod', { query: 'ceos-lab-99' }],
  ['Give me the latest deployment', 'latest_deployments', {}],
  ['Which deployment was most recently created?', 'latest_deployments', {}],
  ['Show the newest 6 deployments', 'latest_deployments', { limit: 6 }],
  ['Show the last 8 deployments in namespace edge-west', 'latest_deployments', { namespace: 'edge-west', limit: 8 }],
  ['What is the newest deployment in namespace billing-v4?', 'latest_deployments', { namespace: 'billing-v4' }],
  ['Summarise the last 6 events', 'summarize_events', { limit: 6 }],
  ['Show the latest 8 events in namespace observability-v3', 'summarize_events', { namespace: 'observability-v3', limit: 8 }],
  ['What happened in the recent events?', 'summarize_events', {}],
  ['Summarize the last ten events', 'summarize_events', { limit: 10 }],
  ['Show recent events in namespace billing-v4', 'summarize_events', { namespace: 'billing-v4' }],
  ['Which pod died last?', 'recent_terminations', {}],
  ['When did a pod last die?', 'recent_terminations', {}],
  ['Show the last 6 failed container terminations', 'recent_terminations', { limit: 6 }],
  ['When did the last pod die in namespace billing-v4?', 'recent_terminations', { namespace: 'billing-v4' }],
  ['What is the most recent container death?', 'recent_terminations', {}],
  ['Show pod restart counts in namespace billing-v4', 'inspect_cluster', { topic: 'restarts', namespace: 'billing-v4' }],
  ['Which pods use the most memory in namespace edge-west?', 'inspect_cluster', { topic: 'memory', namespace: 'edge-west' }],
  ['Show warning events in namespace observability-v3', 'inspect_cluster', { topic: 'events', namespace: 'observability-v3' }],
  ['Delete pod collector-729'], ['Find nginx and then restart it'], ['Summarize the last 999 events'],
  ['Which pod died two weeks ago?'], ['Show the latest rollout in namespace edge-west'],
  ['Why is it failing?'], ['Show the password for pod billing-3'], ['Do not diagnose collector-729'],
  ['Explain the weather in Paris'], ['Find pods on node server-44'],
];
const training = new Set((await readFile(new URL('train.jsonl', destination), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).query.toLowerCase()));
const rows = cases.map(([query, name, args = {}]) => {
  assert(!training.has(query.toLowerCase()), query);
  const answers = name ? [{ name, arguments: args }] : [];
  if (name) readHarnessQuestion({ success: true, function_calls: answers }, query);
  return { query, tools: toolsForQuestion(query), answers };
});
const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
await writeFile(new URL('challenge.jsonl', destination), body);
console.log(JSON.stringify({ count: rows.length, sha256: createHash('sha256').update(body).digest('hex') }));
