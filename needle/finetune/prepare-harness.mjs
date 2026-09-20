// Synthetic task selection and grounded arguments; no cluster data or hosted API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readHarnessQuestion, toolsForQuestion } from '../../client/src/needle/cluster-query.ts';

const destination = new URL('../../.cache/needle-training/harness/', import.meta.url);
const source = new URL('../../.cache/needle-training/cluster/', import.meta.url);
const train = [];
const test = [];
const seen = new Set();
function add(target, query, name, args = {}) {
  if (seen.has(query.toLowerCase())) return;
  const answers = name ? [{ name, arguments: args }] : [];
  const tools = toolsForQuestion(query);
  if (name) {
    assert(tools.some((entry) => entry.name === name), query);
    try { readHarnessQuestion({ success: true, function_calls: answers }, query); }
    catch (error) { throw new Error(`${query}: ${error.message}`); }
  }
  seen.add(query.toLowerCase());
  target.push({ query, tools, answers, reasoning: name ? `${name}.${Object.entries(args).map(([key, value]) => ` ${key}: ${value}.`).join('')}` : 'No supported read workflow satisfies this request.' });
}
// Keep the previously measured report coverage, with the actual new shortlists.
for (const file of ['train', 'test']) {
  const rows = (await readFile(new URL(`${file}.jsonl`, source), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const row of rows) {
    const call = row.answers[0];
    // Prefix wording such as "What is deployed" remains a plain inventory.
    add(file === 'train' ? train : test, row.query, call?.name, call?.arguments);
  }
}
const namespaces = ['production', 'staging', 'network-lab', 'default', 'team-a'];
const names = ['ceos', 'router', 'api-7bf89', 'web-0', 'frontend', 'database-0', 'cache', 'coredns', 'app=web', 'registry.local/ceos:4.34'];
const find = ['Where is my {q} pod?', 'In which namespace is my {q} pod?', 'Find pods matching {q}', 'Locate pod {q}', 'Which namespace contains pod {q}?', 'Search pods for {q}', 'Where can I find {q}?'];
const diagnose = ['Why is pod {q} failing?', 'Diagnose pod {q}', 'Troubleshoot {q}', 'Why is {q} stuck?', 'Debug pod {q}', 'Why is my {q} pod not running?', 'Why does {q} keep crashing?'];
for (const [tool, phrases] of [['find_pods', find], ['diagnose_pod', diagnose]]) {
  for (const query of names) for (const phrase of phrases) {
    const prompt = phrase.replace('{q}', query);
    add(train, prompt, tool, { query });
    for (const namespace of namespaces) add(train, `${prompt.replace(/\?$/, '')} in namespace ${namespace}`, tool, { query, namespace });
  }
}
const tasks = {
  latest_deployments: ['What is the latest deployment?', 'Show the newest deployment', 'Which deployment was created most recently?', 'Show recent deployments', 'What was the last deployment created?', 'Find the newest deployments'],
  summarize_events: ['Summarize the last events', 'What happened in the latest events?', 'Show recent events', 'Summarise the newest Kubernetes events', 'What are the last events?', 'Summarize events including Normal and Warning'],
  recent_terminations: ['When did the last pod die?', 'When did the last pod died?', 'Which pod died most recently?', 'Show recent failed container terminations', 'What was the last container crash?', 'When was a container last killed?', 'Show the last recorded container death', 'Which container terminated with an error most recently?'],
};
for (const [name, phrases] of Object.entries(tasks)) {
  for (const phrase of phrases) for (const prefix of ['', 'Please: ', 'In Kubus, ']) {
    add(train, prefix + phrase, name);
    for (const namespace of namespaces) add(train, `${prefix}${phrase.replace(/\?$/, '')} in namespace ${namespace}`, name, { namespace });
  }
}
for (const [name, subject] of [['latest_deployments', 'deployments'], ['summarize_events', 'events'], ['recent_terminations', 'failed container terminations']]) {
  for (const limit of [1, 2, 3, 5, 10, 15, 20]) for (const verb of ['Show the last', 'Summarize the latest', 'Show the newest']) {
    add(train, `${verb} ${limit} ${subject}`, name, { limit });
    for (const namespace of namespaces) add(train, `${verb} ${limit} ${subject} in namespace ${namespace}`, name, { namespace, limit });
  }
}
for (const query of [
  'Summarize the last 100 events', 'Show the last 0 events', 'Why is my pod failing?', 'Where is my pod?',
  'Delete the failing pod', 'Find ceos and delete it', 'Diagnose all pods and fix them', 'Restart pod api-7bf89',
  'Which pod died yesterday?', 'Show terminations from last week', 'What was the latest rollout?',
  'Find pods in production or staging', 'Do not diagnose pod web-0', 'Show the last 10 events and restart pods',
]) for (const prefix of ['', 'Please: ', 'In Kubus, ']) add(train, prefix + query);

// Development examples use separate wording and unseen names/namespaces.
for (const [query, name, args] of [
  ['Where are pods using srlinux?', 'find_pods', { query: 'srlinux' }],
  ['Find pods matching app=payments in namespace edge-test', 'find_pods', { query: 'app=payments', namespace: 'edge-test' }],
  ['Where is my ceos pod?', 'find_pods', { query: 'ceos' }],
  ['Why is pod basket-6fd3 failing in namespace checkout-v2?', 'diagnose_pod', { query: 'basket-6fd3', namespace: 'checkout-v2' }],
  ['Debug the checkout pod', 'diagnose_pod', { query: 'checkout' }],
  ['Which deployment is the newest?', 'latest_deployments', {}],
  ['Show the latest 4 deployments in namespace checkout-v2', 'latest_deployments', { namespace: 'checkout-v2', limit: 4 }],
  ['Summarize the last 10 events', 'summarize_events', { limit: 10 }],
  ['Show the last 7 events in namespace edge-test', 'summarize_events', { namespace: 'edge-test', limit: 7 }],
  ['Which pod was last killed?', 'recent_terminations', {}],
  ['When did the last pod die in namespace edge-test?', 'recent_terminations', { namespace: 'edge-test' }],
  ['Show the last 4 failed container terminations', 'recent_terminations', { limit: 4 }],
]) add(test, query, name, args);
for (const query of ['Summarize the last 21 events', 'Find payment pods and delete them', 'When did pods die last month?', 'What is the latest rollout of checkout?', 'Diagnose pod missing and scale it', 'Where is the password for ceos?']) add(test, query);

await mkdir(destination, { recursive: true });
const manifest = { seed: 20260920, source: 'Synthetic harness workflows plus the v1 report corpus; development set is not blind.', files: {} };
for (const [name, rows] of [['train', train], ['test', test]]) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(new URL(`${String(name)}.jsonl`, destination), body);
  manifest.files[name] = { count: rows.length, refusals: rows.filter((row) => !row.answers.length).length, sha256: createHash('sha256').update(body).digest('hex') };
}
await writeFile(new URL('manifest.json', destination), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
