import './source-loader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const { readHarnessQuestion, toolsForQuestion } = await import('../../client/src/needle/cluster-query.ts');
const dest = new URL('../../.cache/needle-training/exploration/', import.meta.url);
// Written before observing v3 model results. Validators may subsequently be refined;
// this is a development challenge, not a blind or representative production score.
const examples = [
  ['Show the status of my eos-router pods', 'query_pods', { query: 'eos-router' }],
  ['How many arista pods are there in namespace rack-c?', 'query_pods', { query: 'arista', namespace: 'rack-c' }],
  ['Show pods matching vendor=arista on node rack-worker', 'query_pods', { query: 'vendor=arista', node: 'rack-worker' }],
  ['List pending pods matching router', 'query_pods', { query: 'router', status: 'Pending' }],
  ['Show failed pods on node rack-worker in namespace rack-c', 'query_pods', { status: 'Failed', node: 'rack-worker', namespace: 'rack-c' }],
  ['Show the oldest 7 pods in namespace rack-c', 'query_pods', { sort: 'oldest', limit: 7, namespace: 'rack-c' }],
  ['What is my newest eos-router pod?', 'query_pods', { query: 'eos-router', sort: 'newest' }],
  ['Show memory usage for pod eos-router', 'query_pods', { query: 'eos-router', sort: 'memory' }],
  ['Show CPU usage for pod eos-router in namespace rack-c', 'query_pods', { query: 'eos-router', sort: 'cpu', namespace: 'rack-c' }],
  ['Show restart counts for pod eos-router', 'query_pods', { query: 'eos-router', sort: 'restarts' }],
  ['Give me the logs of the eos-router pod in namespace rack-c', 'pod_logs', { query: 'eos-router', namespace: 'rack-c' }],
  ['Show previous logs for pod checkout-1 container backend', 'pod_logs', { query: 'checkout-1', previous: true, container: 'backend' }],
  ['Show logs from pod telemetry-2', 'pod_logs', { query: 'telemetry-2' }],
  ['Count config maps in namespace rack-c', 'list_configmaps', { namespace: 'rack-c' }],
  ['List configmaps matching router-settings', 'list_configmaps', { query: 'router-settings' }],
  ['Which secrets exist in namespace rack-c?', 'list_secrets', { namespace: 'rack-c' }],
  ['How many secrets in all namespaces?', 'list_secrets', {}],
  ['List secrets matching router-auth', 'list_secrets', { query: 'router-auth' }],
  ['Who owns IP 10.43.0.99?', 'lookup_ip', { ip: '10.43.0.99' }],
  ['What is using 172.20.4.7 in namespace rack-c?', 'lookup_ip', { ip: '172.20.4.7', namespace: 'rack-c' }],
  ['Which resource has IP 2001:db8:42::9?', 'lookup_ip', { ip: '2001:db8:42::9' }],
  ['Any 9443 port open in namespace rack-c?', 'lookup_port', { port: 9443, namespace: 'rack-c' }],
  ['What uses UDP port 514?', 'lookup_port', { port: 514, protocol: 'UDP' }],
  ['Show services on port 9093', 'lookup_port', { port: 9093 }],
  ['Find TCP port 179', 'lookup_port', { port: 179, protocol: 'TCP' }],
  ['Show available images matching arista', 'list_images', { source: 'both', query: 'arista' }],
  ['List pod images in namespace rack-c', 'list_images', { source: 'workloads', namespace: 'rack-c' }],
  ['Which images are cached on node rack-worker?', 'list_images', { source: 'cached', node: 'rack-worker' }],
  ['How much free memory on node rack-worker?', 'node_capacity', { node: 'rack-worker' }],
  ['Tell me about CPU headroom', 'node_capacity', {}],
  ['What is the CPU and memory capacity of this cluster?', 'node_capacity', {}],
  ['In which namespace is my eos-router pod?', 'find_pods', { query: 'eos-router' }],
  ['Diagnose pod telemetry-2', 'diagnose_pod', { query: 'telemetry-2' }],
  ['Summarize the last 8 events in namespace rack-c', 'summarize_events', { limit: 8, namespace: 'rack-c' }],
  ['What is the latest deployment in namespace rack-c?', 'latest_deployments', { namespace: 'rack-c' }],
  ['When did the last pod die in namespace rack-c?', 'recent_terminations', { namespace: 'rack-c' }],
  ['Show secret values in namespace rack-c'], ['Show config-map data'], ['Delete pods matching eos-router'],
  ['Show pods matching router and scale them'], ['Show previous logs for pod router since yesterday'],
  ['Show the last 500 lines of logs for pod router'], ['Follow the logs for pod router'],
  ['Which pod died last week?'], ['Do not list secrets'], ['Any 70000 port open?'],
  ['Who owns 999.2.3.4?'], ['Show the newest 30 pods'], ['List available images in namespace rack-c'],
  ['How much free CPU in namespace rack-c?'],
];
const training = new Set((await readFile(new URL('train.jsonl', dest), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).query.toLowerCase()));
const rows = examples.map(([query, name, args = {}]) => {
  const answers = name ? [{ name, arguments: args }] : [];
  const tools = toolsForQuestion(query);
  if (name) readHarnessQuestion({ success: true, function_calls: answers }, query);
  return { query, tools, answers };
});
// Keep prompt strings distinct from training, including the canonical questions.
const overlaps = rows.filter((row) => training.has(row.query.toLowerCase())).map((row) => row.query);
assert(rows.length === 50);
assert.deepEqual(overlaps, []);
const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
await mkdir(dest, { recursive: true });
await writeFile(new URL('challenge.jsonl', dest), body);
console.log(JSON.stringify({ total: rows.length, supported: rows.filter((row) => row.answers.length).length, trainingOverlaps: overlaps, sha256: createHash('sha256').update(body).digest('hex') }, null, 2));
// Acceptance examples intentionally repeat user wording / training families.
// Keep them separate from challenge accuracy.
const smoke = [
  ['what is the status of the ceos pods', 'query_pods', { query: 'ceos' }],
  ['give me the logs of the ceos pod', 'pod_logs', { query: 'ceos' }],
  ['what is my oldest pod', 'query_pods', { sort: 'oldest' }],
  ['what is my newest pod', 'query_pods', { sort: 'newest' }],
  ['what config-maps do I have?', 'list_configmaps', {}],
  ['how many secrets?', 'list_secrets', {}],
  ['what is using 10.96.0.10 ?', 'lookup_ip', { ip: '10.96.0.10' }],
  ['Any 443 port open?', 'lookup_port', { port: 443 }],
  ['Which images are available?', 'list_images', { source: 'both' }],
  ['How much free memory/cpu on my cluster/node', 'node_capacity', {}],
  ['Show the newest ceos pods on node worker-1 in namespace production', 'query_pods', { query: 'ceos', node: 'worker-1', namespace: 'production', sort: 'newest' }],
  ['Show previous logs for pod web', 'pod_logs', { query: 'web', previous: true }],
  ['Which pods restart most in namespace production?', 'query_pods', { sort: 'restarts', namespace: 'production' }],
  ['Where is 10.96.0.10?', 'lookup_ip', { ip: '10.96.0.10' }],
].map(([query, name, args]) => {
  const answers = [{ name, arguments: args }];
  readHarnessQuestion({ success: true, function_calls: answers }, query);
  return { query, tools: toolsForQuestion(query), answers };
});
await writeFile(new URL('smoke.jsonl', dest), smoke.map((row) => JSON.stringify(row)).join('\n') + '\n');
