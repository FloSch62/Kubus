import './source-loader.mjs';
// Reproducible synthetic v3 corpus. No live cluster data or hosted service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const { readHarnessQuestion, toolsForQuestion } = await import('../../client/src/needle/cluster-query.ts');
const dest = new URL('../../.cache/needle-training/exploration/', import.meta.url);
const train = [], test = [], failures = [], seen = new Set();
function add(target, query, name, args = {}) {
  if (seen.has(query.toLowerCase())) return;
  const answers = name ? [{ name, arguments: args }] : [];
  const tools = toolsForQuestion(query);
  if (name) {
    assert(tools.some((entry) => entry.name === name), `${query}: missing ${name}`);
    try { readHarnessQuestion({ success: true, function_calls: answers }, query); }
    catch (error) { failures.push(`${query} ${JSON.stringify(answers)}: ${error.message}`); }
  }
  seen.add(query.toLowerCase());
  target.push({ query, tools, answers, reasoning: name ? `${name}.${Object.entries(args).map(([key, value]) => ` ${key}: ${value}.`).join('')}` : 'No supported read workflow satisfies this request.' });
}
// Historical generic reports retain their tool; pod images gain explicit source.
for (const file of ['train', 'test']) {
  const rows = (await readFile(new URL(`../../.cache/needle-training/cluster/${file}.jsonl`, import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const row of rows) {
    const c = row.answers[0];
    if (!c && /(?:show|get) secrets in /i.test(row.query)) {
      const namespace = /\bin (?:namespace )?([a-z0-9-]+)$/i.exec(row.query)?.[1];
      add(file === 'train' ? train : test, row.query, 'list_secrets', { namespace });
    }
    else if (!c && /\bpods (?:are )?on node\b/i.test(row.query)) {
      const node = /\bon node ([a-z0-9-]+)/i.exec(row.query)[1];
      add(file === 'train' ? train : test, row.query, 'query_pods', { node });
    }
    else if (!c && /\bpods (?:with|have) label\b/i.test(row.query)) {
      const query = /\blabel ([a-z0-9_=.-]+)/i.exec(row.query)[1];
      add(file === 'train' ? train : test, row.query, 'query_pods', { query });
    }
    else if (c?.arguments.topic === 'nodes' && /\bcapacity\b/i.test(row.query)) add(file === 'train' ? train : test, row.query, 'node_capacity', c.arguments.name ? { node: c.arguments.name } : {});
    else if (c?.arguments.topic === 'images') add(file === 'train' ? train : test, row.query, 'list_images', { source: 'workloads', ...(c.arguments.namespace ? { namespace: c.arguments.namespace } : {}), ...(c.arguments.name ? { query: c.arguments.name } : {}) });
    else if (['pods', 'restarts', 'cpu', 'memory'].includes(c?.arguments.topic) && c.arguments.name) add(file === 'train' ? train : test, row.query, 'query_pods', { query: c.arguments.name, ...(c.arguments.topic !== 'pods' ? { sort: c.arguments.topic } : {}), ...(c.arguments.namespace ? { namespace: c.arguments.namespace } : {}) });
    else add(file === 'train' ? train : test, row.query, c?.name, c?.arguments);
  }
}
const names = ['ceos', 'srlinux', 'router', 'api-7bf89', 'web-0', 'frontend', 'database-0', 'cache', 'coredns', 'app=web', 'registry.local/ceos:4.34'];
const namespaces = ['production', 'staging', 'network-lab', 'default'];
function scoped(prompt, tool, args = {}) {
  add(train, prompt, tool, args);
  for (const namespace of namespaces) add(train, `${prompt.replace(/\?$/, '')} in namespace ${namespace}`, tool, { ...args, namespace });
}
for (const query of names) {
  for (const prompt of [`Where is my ${query} pod?`, `In which namespace is my ${query} pod?`, `Find pods matching ${query}`, `Locate pod ${query}`]) scoped(prompt, 'find_pods', { query });
  for (const prompt of [`Why is pod ${query} failing?`, `Diagnose pod ${query}`, `Troubleshoot ${query}`, `Why does ${query} keep crashing?`]) scoped(prompt, 'diagnose_pod', { query });
  for (const prompt of [`What is the status of the ${query} pods?`, `Show ${query} pods`, `Show pods matching ${query}`, `How many ${query} pods are there?`, `List pods using ${query}`]) scoped(prompt, 'query_pods', { query });
  for (const prompt of [`Give me the logs of the ${query} pod`, `Show logs for pod ${query}`, `Get logs from pod ${query}`]) scoped(prompt, 'pod_logs', { query });
  scoped(`Show previous logs for pod ${query}`, 'pod_logs', { query, previous: true });
  scoped(`Show logs for pod ${query} container main`, 'pod_logs', { query, container: 'main' });
  for (const [word, sort] of [['oldest', 'oldest'], ['newest', 'newest'], ['most restarted', 'restarts']]) {
    const prompt = sort === 'restarts' ? `Show restart counts for pod ${query}` : `What is my ${word} ${query} pod?`;
    scoped(prompt, 'query_pods', { query, sort });
  }
  for (const [word, status] of [['Running', 'Running'], ['Pending', 'Pending'], ['Failed', 'Failed'], ['unhealthy', 'unhealthy'], ['not ready', 'not_ready'], ['CrashLoopBackOff', 'CrashLoopBackOff']]) scoped(`Show ${word} pods matching ${query}`, 'query_pods', { query, status });
  for (const node of ['worker-1', 'kind-control-plane']) add(train, `Show ${query} pods on node ${node}`, 'query_pods', { query, node });
}
for (const [sort, phrases] of [
  ['oldest', ['What is my oldest pod?', 'Which pod is oldest?', 'Show oldest pods']],
  ['newest', ['What is my newest pod?', 'Which pod is newest?', 'Show newest pods']],
  ['restarts', ['Which pods restart most?', 'Show pod restart counts', 'Show pods with the most restarts']],
  ['cpu', ['Which pods use the most CPU?', 'Show pod CPU usage']],
  ['memory', ['Which pods use the most memory?', 'Show pod memory usage']],
]) for (const phrase of phrases) scoped(phrase, 'query_pods', { sort });
for (const sort of ['oldest', 'newest']) for (const limit of [1, 2, 3, 5, 10, 20]) scoped(`Show the ${sort} ${limit} pods`, 'query_pods', { sort, limit });
for (const [word, status] of [['running', 'Running'], ['pending', 'Pending'], ['failed', 'Failed'], ['completed', 'Succeeded'], ['unknown', 'Unknown'], ['unhealthy', 'unhealthy'], ['not ready', 'not_ready'], ['crashlooping', 'CrashLoopBackOff']]) scoped(`Show ${word} pods`, 'query_pods', { status });
for (const node of ['worker-1', 'worker-2', 'kind-control-plane']) {
  for (const prompt of [`Show pods on node ${node}`, `What pods are on node ${node}?`]) scoped(prompt, 'query_pods', { node });
  for (const prompt of [`How much free memory on node ${node}?`, `How much free CPU on node ${node}?`, `Show CPU and memory capacity for node ${node}`, `What is the allocatable memory of node ${node}?`]) add(train, prompt, 'node_capacity', { node });
  add(train, `Which images are cached on node ${node}?`, 'list_images', { source: 'cached', node });
}
for (const prompt of ['How much free memory/cpu on my cluster/node', 'How much free memory on my cluster?', 'How much free CPU on my cluster?', 'How much free memory and CPU does my cluster have?', 'Show cluster capacity', 'Show available cluster resources', 'Show remaining CPU and memory', 'How much unrequested CPU is there?', 'How much CPU headroom do I have?']) {
  add(train, prompt, 'node_capacity');
}
for (const [tool, words] of [['list_configmaps', ['config-maps', 'config maps', 'configmaps']], ['list_secrets', ['secrets']]]) for (const word of words) {
  for (const prompt of [`What ${word} do I have?`, `How many ${word}?`, `List ${word}`, `Show ${word}`, `Count ${word}`, `Which ${word} exist?`]) scoped(prompt, tool);
  for (const query of ['app-config', 'dns', 'database']) scoped(`List ${word} matching ${query}`, tool, { query });
}
for (const ip of ['10.96.0.10', '10.96.0.1', '10.244.1.23', '192.168.1.10', '172.18.0.3', 'fd00::10', '2001:db8::1']) for (const prompt of [`What is using ${ip}?`, `Who owns IP ${ip}?`, `Find ${ip} in my cluster`, `Which resource has IP ${ip}?`]) scoped(prompt, 'lookup_ip', { ip });
for (const port of [22, 53, 80, 443, 8080, 8443, 6443, 30080]) {
  for (const prompt of [`Any ${port} port open?`, `Who uses port ${port}?`, `Show services on port ${port}`, `Find port ${port}`]) scoped(prompt, 'lookup_port', { port });
  for (const protocol of ['TCP', 'UDP', 'SCTP']) scoped(`What uses ${protocol} port ${port}?`, 'lookup_port', { port, protocol });
}
for (const [source, phrases] of [
  ['both', ['Which images are available?', 'Show available images', 'List both cached and workload images']],
  ['cached', ['Which images are cached?', 'Show downloaded images', 'List node image cache']],
  ['workloads', ['Which images are used?', 'List pod images', 'Show container images', 'What images do my pods use?']],
]) for (const phrase of phrases) {
  if (source === 'workloads') scoped(phrase, 'list_images', { source }); else add(train, phrase, 'list_images', { source });
  for (const query of ['ceos', 'nginx', 'registry.local/web:v2']) add(train, `${phrase.replace(/\?$/, '')} matching ${query}`, 'list_images', { source, query });
}
for (const [name, phrases] of [
  ['latest_deployments', ['What is the latest deployment?', 'Show the newest deployment', 'Which deployment was created most recently?', 'Show recent deployments']],
  ['summarize_events', ['Summarize the last events', 'What happened in the latest events?', 'Show recent events', 'Summarize events including Normal and Warning']],
  ['recent_terminations', ['When did the last pod die?', 'When did the last pod died?', 'Which pod died most recently?', 'Show recent failed container terminations', 'What was the last container crash?', 'When was a container last killed?']],
]) for (const phrase of phrases) scoped(phrase, name);
for (const [name, subject] of [['latest_deployments', 'deployments'], ['summarize_events', 'events'], ['recent_terminations', 'failed container terminations']]) for (const limit of [1, 2, 3, 5, 10, 15, 20]) for (const verb of ['Show the last', 'Summarize the latest', 'Show the newest']) scoped(`${verb} ${limit} ${subject}`, name, { limit });
for (const query of [
  'Delete the failing pod', 'Find ceos and delete it', 'Restart pod api-7bf89', 'Fix the failing ceos pod', 'Scale the deployment',
  'Show secret values', 'Decode the database secret', 'Read the contents of config-map app-config', 'What is my database password?',
  'Get logs of pod web-0 since yesterday', 'Show the last 500 log lines', 'Follow logs of pod ceos', 'Show pod logs from last week',
  'Which pod died yesterday?', 'Show terminations from last week', 'What was the latest rollout?', 'Find pods in production or staging',
  'Do not show logs for pod web-0', 'Summarize the last 100 events', 'Show the oldest 100 pods', 'What uses port 70000?', 'Who owns 999.96.0.10?',
  'Show available images in namespace production', 'How much free memory in namespace production?', 'Show pod environment variables',
]) for (const prefix of ['', 'Please: ', 'In Kubus, ']) add(train, prefix + query);
// Development questions have held-out names and wordings, not a production benchmark.
for (const [prompt, name, args] of [
  ['What is the status of the ceos pods', 'query_pods', { query: 'ceos' }],
  ['Give me the logs of the ceos pod', 'pod_logs', { query: 'ceos' }],
  ['What is my oldest pod', 'query_pods', { sort: 'oldest' }],
  ['What is my newest pod', 'query_pods', { sort: 'newest' }],
  ['What config-maps do I have?', 'list_configmaps', {}], ['How many secrets?', 'list_secrets', {}],
  ['What is using 10.96.0.10?', 'lookup_ip', { ip: '10.96.0.10' }], ['Any 443 port open?', 'lookup_port', { port: 443 }],
  ['Which images are available?', 'list_images', { source: 'both' }], ['How much free memory/cpu on my cluster/node', 'node_capacity', {}],
  ['Show pods matching basket in namespace checkout-v2', 'query_pods', { query: 'basket', namespace: 'checkout-v2' }],
  ['Show pending pods on node worker-east', 'query_pods', { status: 'Pending', node: 'worker-east' }],
  ['Show the oldest 4 pods in namespace checkout-v2', 'query_pods', { sort: 'oldest', limit: 4, namespace: 'checkout-v2' }],
  ['Show previous logs for pod basket-827 container proxy', 'pod_logs', { query: 'basket-827', container: 'proxy', previous: true }],
  ['List config maps matching payment in namespace checkout-v2', 'list_configmaps', { query: 'payment', namespace: 'checkout-v2' }],
  ['What uses UDP port 5353?', 'lookup_port', { port: 5353, protocol: 'UDP' }],
  ['Which resource has IP fd00:abcd::42?', 'lookup_ip', { ip: 'fd00:abcd::42' }],
  ['Show images cached on node worker-east', 'list_images', { source: 'cached', node: 'worker-east' }],
  ['How much free CPU on node worker-east?', 'node_capacity', { node: 'worker-east' }],
  ['Summarize the last 10 events', 'summarize_events', { limit: 10 }],
  ['Why is pod basket-827 failing in namespace checkout-v2?', 'diagnose_pod', { query: 'basket-827', namespace: 'checkout-v2' }],
]) add(test, prompt, name, args);
for (const prompt of ['Reveal secret values in namespace checkout-v2', 'Show pods matching basket and delete them', 'Show logs for pod basket-827 since yesterday', 'Find port 99999', 'Who owns 999.1.1.1?', 'List the newest 25 pods']) add(test, prompt);
if (failures.length) throw new Error(failures.join('\n'));
await mkdir(dest, { recursive: true });
const manifest = { seed: 20260921, description: 'Synthetic exploration workflows plus generic v1 reports. Development set may inform iteration.', files: {} };
for (const [name, rows] of [['train', train], ['test', test]]) {
  const data = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(new URL(`${String(name)}.jsonl`, dest), data);
  manifest.files[name] = { count: rows.length, refusals: rows.filter((row) => !row.answers.length).length, sha256: createHash('sha256').update(data).digest('hex') };
}
await writeFile(new URL('manifest.json', dest), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
