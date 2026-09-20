import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { answerClusterQuestion } from '../../../client/src/needle/cluster-answer';
import { readHarnessQuestion } from '../../../client/src/needle/cluster-query';
import { configuredPodRequest } from '../../../client/src/needle/explore-answer';
import type { EvidenceReader } from '../../../client/src/needle/evidence-reader';
const scope = { context: 'lab', namespaces: ['lab'] };
const signal = () => new AbortController().signal;
const call = (name: string, args: Record<string, unknown>) => ({ success: true, function_calls: [{ name, arguments: args }] });
const pod = (name: string, extra: Partial<KubeObject> = {}): KubeObject => ({ kind: 'Pod', metadata: { name, namespace: 'lab', uid: name, creationTimestamp: '2026-01-01T00:00:00Z' }, spec: { nodeName: 'worker-1', containers: [{ name: 'main', image: 'registry/ceos:4.35' }] }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'main', ready: true, restartCount: 1 }] }, ...extra });
const reader = (resources: Record<string, unknown>): EvidenceReader => async <T>(path: string, init?: RequestInit): Promise<T> => {
  expect(init?.method).toBeUndefined();
  const key = new URL(path, 'http://kubus').pathname.split('/').pop()!;
  if (!(key in resources)) throw new Error(`Unexpected read: ${path}`);
  return resources[key] as T;
};

describe('exploration extraction', () => {
  it.each([
    ['query_pods', { query: 'ceos' }, 'What is the status of the ceos pods', { topic: 'query_pods', name: 'ceos' }],
    ['query_pods', { sort: 'oldest' }, 'What is my oldest pod', { topic: 'query_pods', sort: 'oldest' }],
    ['query_pods', { sort: 'newest', limit: 3, query: 'ceos', node: 'worker-1', namespace: 'lab' }, 'Show the newest 3 ceos pods on node worker-1 in namespace lab', { topic: 'query_pods', sort: 'newest', limit: 3, name: 'ceos', node: 'worker-1', namespace: 'lab' }],
    ['query_pods', { query: 'vendor=CeoS' }, 'Show pods matching vendor=CeoS', { topic: 'query_pods', name: 'vendor=CeoS' }],
    ['query_pods', { query: 'app=web', status: 'Pending' }, 'Show pending pods matching app=web', { topic: 'query_pods', name: 'app=web', status: 'Pending' }],
    ['pod_logs', { query: 'ceos' }, 'Give me the logs of the ceos pod', { topic: 'pod_logs', name: 'ceos' }],
    ['pod_logs', { query: 'ceos', container: 'main', previous: true }, 'Show previous logs for pod ceos container main', { topic: 'pod_logs', name: 'ceos', container: 'main', previous: true }],
    ['list_configmaps', {}, 'What config-maps do I have?', { topic: 'list_configmaps' }],
    ['list_secrets', { namespace: 'lab' }, 'How many secrets in namespace lab?', { topic: 'list_secrets', namespace: 'lab' }],
    ['lookup_ip', { ip: '10.96.0.10' }, 'What is using 10.96.0.10?', { topic: 'lookup_ip', ip: '10.96.0.10' }],
    ['lookup_ip', { ip: '10.96.0.10' }, 'Where is 10.96.0.10?', { topic: 'lookup_ip', ip: '10.96.0.10' }],
    ['lookup_ip', { ip: 'fd00:abcd::42' }, 'Who owns fd00:abcd::42?', { topic: 'lookup_ip', ip: 'fd00:abcd::42' }],
    ['lookup_port', { port: 443 }, 'Any 443 port open?', { topic: 'lookup_port', port: 443 }],
    ['lookup_port', { port: 53, protocol: 'UDP' }, 'What uses UDP port 53?', { topic: 'lookup_port', port: 53, protocol: 'UDP' }],
    ['list_images', { source: 'both' }, 'Which images are available?', { topic: 'list_images', source: 'both' }],
    ['list_images', { source: 'cached', node: 'worker-1' }, 'Show images cached on node worker-1', { topic: 'list_images', source: 'cached', node: 'worker-1' }],
    ['node_capacity', {}, 'How much free memory/cpu on my cluster/node', { topic: 'node_capacity' }],
    ['node_capacity', { node: 'worker-1' }, 'Show node worker-1 capacity', { topic: 'node_capacity', node: 'worker-1' }],
    ['query_pods', { query: 'cpu-pending-router', namespace: 'memory' }, 'Show cpu-pending-router pods in namespace memory', { topic: 'query_pods', name: 'cpu-pending-router', namespace: 'memory' }],
    ['query_pods', { namespace: 'all' }, 'Show pods in namespace all', { topic: 'query_pods', namespace: 'all' }],
  ])('preserves the requested workflow and arguments: %s %j', (name, args, prompt, expected) => {
    expect(readHarnessQuestion(call(name as string, args as Record<string, unknown>), prompt as string)).toEqual(expected);
  });
  it.each([
    ['inspect_cluster', { topic: 'pods' }, 'What is the status of the ceos pods'],
    ['query_pods', {}, 'What is the status of the ceos pods'],
    ['query_pods', { query: 'api' }, 'Show pods matching ceos'],
    ['query_pods', { query: 'ceos' }, 'Show pending ceos pods'],
    ['query_pods', { query: 'ceos' }, 'Show ceos pods on node worker-1'],
    ['query_pods', { sort: 'newest' }, 'What is my oldest pod'],
    ['query_pods', { node: 'worker-1', query: 'worker-1' }, 'Show pods on node worker-1'],
    ['query_pods', {}, 'When did the last pod die?'],
    ['query_pods', { query: 'ceos' }, 'Show ceos pods with label app=web'],
    ['query_pods', { sort: 'oldest', limit: 2 }, 'Show the oldest 3 pods'],
    ['query_pods', { query: 'ceos' }, 'Show ceos pods in namespace lab'],
    ['inspect_cluster', { topic: 'pods', name: 'ceos' }, 'What is the status of the ceos pods'],
    ['query_pods', { sort: 'restarts' }, 'Show pods with more than 5 restarts'],
    ['query_pods', { status: 'Running' }, 'Show pods not running'],
    ['query_pods', { query: 'ceos' }, 'Show pods matching ceos or nginx'],
    ['list_secrets', {}, 'List secrets matching database'],
    ['list_secrets', { query: 'secrets' }, 'How many secrets?'],
    ['query_pods', { query: 'vendor=ceos' }, 'Show pods matching vendor=CeoS'],
    ['list_configmaps', { query: 'rack-c', namespace: 'rack-c' }, 'Count config maps in namespace rack-c'],
    ['inspect_cluster', { topic: 'storage', name: 'pvc' }, 'Give me a pvc inventory'],
    ['inspect_cluster', { topic: 'events', name: 'warning' }, 'Show newest warning events'],
    ['query_pods', { query: 'inventory' }, 'Give me the pod inventory'],
    ['inspect_cluster', { topic: 'nodes' }, 'How many workloads and nodes do I have?'],
    ['inspect_cluster', { topic: 'memory' }, 'Which machines are Ready?'],
    ['inspect_cluster', { topic: 'health' }, 'What volumes are my claims bound to?'],
    ['summarize_events', {}, 'Show the newest warning events'],
    ['find_pods', { query: 'nodes', namespace: 'lab' }, 'Find nodes in namespace lab'],
    ['query_pods', { query: 'ceos' }, 'Give me the logs of the ceos pod'],
    ['lookup_port', { port: 443 }, 'Are nodes listening on port 443?'],
    ['list_secrets', {}, 'Reveal the secret values'],
    ['list_configmaps', {}, 'Show config-map contents'],
    ['pod_logs', { query: 'ceos' }, 'Show logs for pod ceos container proxy'],
    ['pod_logs', { query: 'ceos' }, 'Show previous logs for pod ceos'],
    ['pod_logs', { query: 'ceos' }, 'Show logs for pod ceos since yesterday'],
    ['pod_logs', { query: 'ceos' }, 'Follow logs for pod ceos'],
    ['lookup_ip', { ip: '999.96.0.10' }, 'What is using 999.96.0.10?'],
    ['lookup_port', { port: 53 }, 'What uses UDP port 53?'],
    ['lookup_port', { port: 80 }, 'Any 443 port open?'],
    ['lookup_port', { port: 99999 }, 'Any 99999 port open?'],
    ['list_images', { source: 'workloads' }, 'Which images are available?'],
    ['node_capacity', {}, 'How much free memory in namespace lab?'],
    ['node_capacity', {}, 'Show node worker-1 capacity'],
    ['query_pods', {}, 'Show pods in namespace all'],
    ['list_images', { source: 'cached', namespace: 'lab' }, 'Show cached images in namespace lab'],
  ])('rejects a dropped condition or unsupported operation: %s %j', (name, args, prompt) => {
    expect(() => readHarnessQuestion(call(name as string, args as Record<string, unknown>), prompt as string)).toThrow();
  });
});

describe('filtered pod facts', () => {
  it('combines image, node, status and namespace instead of returning every pod', async () => {
    const matching = pod('generated-ceos', { status: { phase: 'Pending' } });
    const answer = await answerClusterQuestion({ topic: 'query_pods', name: 'ceos', status: 'Pending', node: 'worker-1' }, scope, signal(), reader({ pods: { items: [matching,
      pod('other-image', { spec: { nodeName: 'worker-1', containers: [{ image: 'nginx' }] }, status: { phase: 'Pending' } }),
      pod('running'), pod('other-node', { spec: { nodeName: 'worker-2', containers: [{ image: 'ceos' }] }, status: { phase: 'Pending' } }),
      pod('other-namespace', { metadata: { name: 'other-namespace', namespace: 'other', uid: 'other' }, status: { phase: 'Pending' } }),
    ] } }));
    expect(answer.sections[0]?.rows.map((row) => row[1])).toEqual(['generated-ceos']);
    expect(answer.focus?.uid).toBe('generated-ceos');
  });
  it('applies exact label equality rather than a substring of a label value', async () => {
    const pods = ['web', 'web-extra'].map((name) => pod(name, { metadata: { name, uid: name, namespace: 'lab', labels: { app: name } } }));
    const answer = await answerClusterQuestion({ topic: 'query_pods', name: 'app=web' }, scope, signal(), reader({ pods: { items: pods } }));
    expect(answer.sections[0]?.rows.map((row) => row[1])).toEqual(['web']);
  });
  it.each(['oldest', 'newest'] as const)('ranks %s by creation time over every page and excludes undated objects', async (sort) => {
    const read: EvidenceReader = async <T>(path: string): Promise<T> => (path.includes('continue=next') ? { items: [pod('new', { metadata: { name: 'new', uid: 'new', namespace: 'lab', creationTimestamp: '2026-09-20T00:00:00Z' } })] } : { items: [pod('old'), pod('undated', { metadata: { name: 'undated', uid: 'undated', namespace: 'lab' } })], continue: 'next' }) as T;
    const answer = await answerClusterQuestion({ topic: 'query_pods', sort }, scope, signal(), read);
    expect(answer.sections[0]?.rows.map((row) => row[1])).toEqual([sort === 'oldest' ? 'old' : 'new']);
    expect(answer.notices.join(' ')).toContain('1 matching pods lack');
  });
  it('ranks usage only after filtering and discloses unsampled matches', async () => {
    const answer = await answerClusterQuestion({ topic: 'query_pods', name: 'ceos', sort: 'memory' }, scope, signal(), async <T>(path: string): Promise<T> => (path.includes('/metrics/') ? { available: true, items: [{ namespace: 'lab', name: 'one', cpuMilli: 30, memBytes: 104857600 }, { namespace: 'lab', name: 'two', cpuMilli: 1, memBytes: 209715200 }] } : { items: [pod('one'), pod('two'), pod('missing')] }) as T);
    expect(answer.sections[0]?.rows.map((row) => row[1])).toEqual(['two', 'one']);
    expect(answer.sections[0]?.summary).toContain('0.29 GiB across 2 sampled matching pods');
    expect(answer.notices.join(' ')).toContain('2 of 3');
  });
  it('fails incomplete lists rather than claiming a count or oldest pod', async () => {
    await expect(answerClusterQuestion({ topic: 'query_pods', sort: 'oldest' }, scope, signal(), reader({ pods: { items: [pod('one')], continue: 'loop' } }))).rejects.toThrow('incomplete pagination');
  });
});

describe('logs and inventories', () => {
  it('requires a pod choice before reading ambiguous ceos logs', async () => {
    const answer = await answerClusterQuestion({ topic: 'pod_logs', name: 'ceos' }, scope, signal(), reader({ pods: { items: [pod('one'), pod('two')] } }));
    expect(answer.candidates).toHaveLength(2);
    expect(answer.sections[0]?.summary).toContain('Choose the pod whose logs');
  });
  it('asks for a container when there is no unique/default container', async () => {
    const target = pod('ceos', { spec: { containers: [{ name: 'router' }, { name: 'proxy' }] } });
    const answer = await answerClusterQuestion({ topic: 'pod_logs', name: 'ceos' }, scope, signal(), reader({ pods: { items: [target] }, ceos: target }));
    expect(answer.containers?.map((entry) => entry.name)).toEqual(['router', 'proxy']);
  });
  it('reads previous logs only for the selected identity and container', async () => {
    const target = pod('ceos');
    const answer = await answerClusterQuestion({ topic: 'pod_logs', name: 'ceos', container: 'main', previous: true }, scope, signal(), async <T>(path: string): Promise<T> => {
      if (path.includes('/detail/pod-logs')) {
        expect(path).toContain('uid=ceos'); expect(path).toContain('previous=true'); expect(path).toContain('container=main');
        return { uid: 'ceos', text: '<script>untrusted log</script>', truncated: true } as T;
      }
      return (path.includes('/pods/ceos?') ? target : { items: [target] }) as T;
    });
    expect(answer.sections[0]?.text).toContain('<script>');
    expect(answer.notices).toContain('The log excerpt reached its byte limit.');
  });
  it('counts metadata over pages and never requests full Secret objects', async () => {
    const paths: string[] = [];
    const answer = await answerClusterQuestion({ topic: 'list_secrets' }, scope, signal(), async <T>(path: string): Promise<T> => {
      paths.push(path);
      expect(path).toContain('/detail/resource-metadata/secrets');
      return (path.includes('continue=next') ? { items: [pod('two')] } : { items: [pod('one')], continue: 'next' }) as T;
    });
    expect(paths).toHaveLength(2);
    expect(answer.sections[0]?.summary).toBe('2 Secrets in this scope.');
  });
  it('does not convert denied Secret access into a zero count', async () => {
    await expect(answerClusterQuestion({ topic: 'list_secrets' }, scope, signal(), async () => { throw new Error('403 Forbidden'); })).rejects.toThrow('403');
  });
});

describe('network and image evidence', () => {
  it('matches a service IP and an equivalent IPv6 node address while labeling host references', async () => {
    const data = { services: { items: [{ kind: 'Service', metadata: { name: 'dns', namespace: 'lab', uid: 'dns' }, spec: { clusterIP: 'fd00::10' } }] }, pods: { items: [pod('host', { status: { hostIP: 'fd00:0:0:0:0:0:0:10' } })] }, nodes: { items: [{ kind: 'Node', metadata: { name: 'worker', uid: 'worker' }, status: { addresses: [{ type: 'InternalIP', address: 'fd00::10' }] } }] }, ingresses: { items: [] }, endpointslices: { items: [] } };
    const answer = await answerClusterQuestion({ topic: 'lookup_ip', ip: 'fd00::10' }, scope, signal(), reader(data));
    expect(answer.sections[0]?.rows).toHaveLength(3);
    expect(answer.sections[0]?.rows.some((row) => row.includes('hostIP (node address)'))).toBe(true);
  });
  it('distinguishes transport protocols, target and host ports, and does not claim reachability', async () => {
    const answer = await answerClusterQuestion({ topic: 'lookup_port', port: 443, protocol: 'UDP' }, scope, signal(), reader({
      services: { items: [{ metadata: { name: 'quic', namespace: 'lab', uid: 'quic' }, spec: { ports: [{ port: 443, protocol: 'UDP' }, { port: 443, protocol: 'TCP' }] } }] },
      pods: { items: [pod('quic-pod', { spec: { containers: [{ name: 'app', ports: [{ containerPort: 8443, hostPort: 443, protocol: 'UDP' }] }] } })] },
      endpointslices: { items: [] }, ingresses: { items: [{ metadata: { name: 'tls', namespace: 'lab', uid: 'tls' }, spec: { tls: [{ secretName: 'tls-cert' }] } }] },
    }));
    expect(answer.sections[0]?.rows).toHaveLength(2);
    expect(answer.notices.join(' ')).toContain('not a port scan');
  });
  it('reports partial IP coverage when one source is forbidden', async () => {
    const answer = await answerClusterQuestion({ topic: 'lookup_ip', ip: '10.96.0.10' }, scope, signal(), async <T>(path: string): Promise<T> => { if (path.includes('endpointslices')) throw new Error('403 Forbidden'); return { items: [] } as T; });
    expect(answer.sections[0]?.summary).toContain('Coverage is incomplete');
    expect(answer.notices.join(' ')).toContain('endpointslices unavailable');
  });
  it('preserves an explicit Service kind instead of broadening it to pod references', async () => {
    const question = readHarnessQuestion(call('lookup_port', { port: 443 }), 'Show services on port 443');
    const paths: string[] = [];
    await answerClusterQuestion(question, scope, signal(), async <T>(path: string): Promise<T> => { paths.push(path); return { items: [] } as T; });
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('/services?');
  });
  it('distinguishes a pod name from an image-name filter when listing images', async () => {
    const question = readHarnessQuestion(call('list_images', { source: 'workloads', query: 'router' }), 'Show images for pod router');
    const answer = await answerClusterQuestion(question, scope, signal(), reader({ pods: { items: [pod('router'), pod('other', { spec: { containers: [{ image: 'nginx' }] } })] } }));
    expect(answer.sections[0]?.rows.map((row) => row[0])).toEqual(['registry/ceos:4.35']);
  });
  it('separates pod references from cached image aliases and survives missing node permission', async () => {
    const answer = await answerClusterQuestion({ topic: 'list_images', source: 'both' }, scope, signal(), async <T>(path: string): Promise<T> => { if (path.includes('/nodes')) throw new Error('403 Forbidden'); return { items: [pod('one'), pod('two')] } as T; });
    expect(answer.sections[0]?.rows[0]?.slice(0, 3)).toEqual(['registry/ceos:4.35', '2', '2']);
    expect(answer.notices.join(' ')).toContain('Node image cache unavailable');
  });
});

describe('capacity evidence', () => {
  const node = (name: string): KubeObject => ({ metadata: { name, uid: name }, status: { capacity: { cpu: '8', memory: '16Gi' }, allocatable: { cpu: '7', memory: '14Gi' } } });
  it('accounts for sequential init sidecars, overhead and pod-level resource requests', () => {
    const target = pod('init', { spec: { containers: [{ resources: { requests: { cpu: '500m' } } }], initContainers: [
      { restartPolicy: 'Always', resources: { requests: { cpu: '250m' } } },
      { resources: { requests: { cpu: '2' } } },
      { restartPolicy: 'Always', resources: { requests: { cpu: '100m' } } },
    ], overhead: { cpu: '50m' } } });
    expect(configuredPodRequest(target, 'cpu')).toBe(2300);
    target.spec!.resources = { requests: { cpu: '3' } };
    expect(configuredPodRequest(target, 'cpu')).toBe(3050);
  });
  it('keeps physical headroom and unrequested allocatable separate, with cluster-wide request reads', async () => {
    const answer = await answerClusterQuestion({ topic: 'node_capacity' }, scope, signal(), async <T>(path: string): Promise<T> => {
      expect(path).not.toContain('namespace=');
      if (path.includes('/metrics/')) return { available: true, items: [{ name: 'worker-1', cpuMilli: 2000, memBytes: 4 * 1024 ** 3 }] } as T;
      if (path.includes('/nodes')) return { items: [node('worker-1')] } as T;
      return { items: [pod('active', { spec: { nodeName: 'worker-1', containers: [{ resources: { requests: { cpu: '1', memory: '2Gi' } } }] } }), pod('finished', { spec: { nodeName: 'worker-1', containers: [{ resources: { requests: { cpu: '4' } } }] }, status: { phase: 'Succeeded' } })] } as T;
    });
    expect(answer.scope.namespaces).toEqual([]);
    expect(answer.sections[0]?.rows[0]?.slice(2)).toEqual(['8.000 cores', '7.000 cores', '2.000 cores', '6.000 cores', '1.000 cores', '6.000 cores']);
  });
  it('never fills missing node samples with zero or invents a complete free-capacity total', async () => {
    const answer = await answerClusterQuestion({ topic: 'node_capacity' }, scope, signal(), async <T>(path: string): Promise<T> => (path.includes('/metrics/') ? { available: true, items: [{ name: 'worker-1', cpuMilli: 1000, memBytes: 1024 }] } : path.includes('/nodes') ? { items: [node('worker-1'), node('worker-2')] } : { items: [] }) as T);
    expect(answer.sections[0]?.rows[0]?.slice(4, 6)).toEqual(['Unavailable', 'Unavailable']);
    expect(answer.sections[0]?.rows[2]?.slice(4, 6)).toEqual(['Unavailable', 'Unavailable']);
  });
});
