// Written after the final training run started; never included in training.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { CLUSTER_TOOLS, readClusterQuestion } from '../../client/src/needle/cluster-query.ts';

const positive = [
  ['overview', 'Can I get a summary of what is here?'],
  ['overview', 'Count the resources in namespace retail-test', { namespace: 'retail-test' }],
  ['health', 'Does anything in the cluster need attention?'],
  ['health', 'Report workload health in namespace retail-test', { namespace: 'retail-test' }],
  ['pods', 'Let me see the current pods'],
  ['pods', 'Check pod basket-6fd3 in namespace retail-test', { namespace: 'retail-test', name: 'basket-6fd3' }],
  ['nodes', 'What kubelet versions are installed?'],
  ['nodes', 'Check the status of node worker-eu-7', { name: 'worker-eu-7' }],
  ['deployments', 'List available and desired deployment replicas'],
  ['deployments', 'Inspect deployment basket-api in namespace retail-test', { namespace: 'retail-test', name: 'basket-api' }],
  ['services', 'What service IP addresses do we have?'],
  ['services', 'Inspect service basket-http in namespace retail-test', { namespace: 'retail-test', name: 'basket-http' }],
  ['storage', 'List storage claims and the volumes they use'],
  ['storage', 'Show PVC basket-files in namespace retail-test', { namespace: 'retail-test', name: 'basket-files' }],
  ['namespaces', 'Which namespace names can you find?'],
  ['namespaces', 'List the namespaces with their phases'],
  ['events', 'Have there been any warnings recently?'],
  ['events', 'Show warning events for pod basket-6fd3 in namespace retail-test', { namespace: 'retail-test', name: 'basket-6fd3' }],
  ['restarts', 'Rank my pods from most to fewest restarts'],
  ['restarts', 'Show restart counts for pod basket-6fd3 in namespace retail-test', { namespace: 'retail-test', name: 'basket-6fd3' }],
  ['cpu', 'Which pods consume the most CPU right now?'],
  ['cpu', 'Show CPU usage for pod basket-6fd3 in namespace retail-test', { namespace: 'retail-test', name: 'basket-6fd3' }],
  ['memory', 'Rank the pods by current RAM consumption'],
  ['memory', 'Show memory usage for pod basket-6fd3 in namespace retail-test', { namespace: 'retail-test', name: 'basket-6fd3' }],
  ['images', 'What image tags are in the pod specifications?'],
  ['images', 'Show images for pod basket-6fd3 in namespace retail-test', { namespace: 'retail-test', name: 'basket-6fd3' }],
];
const negative = [
  'Delete deployment basket-api', 'Restart all workloads in retail-test',
  'Increase basket-api to five replicas', 'Install Redis in this cluster',
  'Get the database credentials', 'Show the kubeconfig certificate',
  'Execute date inside basket-6fd3', 'Stream the logs from basket-6fd3',
  'Compare memory usage today and yesterday', 'Predict which node will fail next',
  'List pods with label component=basket', 'Show pods scheduled on worker-eu-7',
  'Teach me how to configure an ingress controller', 'Write a poem about containers',
];
const rows = positive.map(([topic, query, args]) => ({
  query, tools: CLUSTER_TOOLS, answers: [{ name: 'inspect_cluster', arguments: { topic, ...args } }], reasoning: '',
})).concat(negative.map((query) => ({ query, tools: CLUSTER_TOOLS, answers: [], reasoning: '' })));
const directory = new URL('../../.cache/needle-training/cluster/', import.meta.url);
const existing = new Set();
for (const file of ['train.jsonl', 'test.jsonl']) {
  for (const line of (await readFile(new URL(file, directory), 'utf8')).trim().split('\n')) existing.add(JSON.parse(line).query.toLowerCase());
}
for (const row of rows) {
  assert(!existing.has(row.query.toLowerCase()));
  assert(row.query.length <= 300);
  if (row.answers.length) readClusterQuestion({ success: true, function_calls: row.answers }, row.query);
}
assert.equal(new Set(rows.map((row) => row.query.toLowerCase())).size, rows.length);
const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
await writeFile(new URL('challenge.jsonl', directory), body);
console.log(JSON.stringify({ total: rows.length, supported: positive.length, unsupported: negative.length, sha256: createHash('sha256').update(body).digest('hex') }));
