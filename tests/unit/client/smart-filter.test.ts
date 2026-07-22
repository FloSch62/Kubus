import type { KubeObject } from '@kubus/shared';
import { describe, expect, it } from 'vitest';
import {
  matchesPlainText,
  matchesSmartFilter,
  parseSmartFilter,
  smartFilterSuggestions,
  type FilterContext,
} from '../../../client/src/smart-filter';

const NOW = Date.parse('2026-07-22T12:00:00Z');

let uidSeq = 0;

interface ObjOpts {
  name?: string;
  namespace?: string;
  kind?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ageSeconds?: number;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

function makeObj(opts: ObjOpts = {}): KubeObject {
  return {
    kind: opts.kind,
    metadata: {
      name: opts.name ?? 'web-1',
      namespace: opts.namespace,
      uid: `uid-${++uidSeq}`,
      creationTimestamp:
        opts.ageSeconds === undefined ? undefined : new Date(NOW - opts.ageSeconds * 1000).toISOString(),
      labels: opts.labels,
      annotations: opts.annotations,
    },
    spec: opts.spec,
    status: opts.status,
  };
}

function healthyPod(opts: ObjOpts = {}): KubeObject {
  return makeObj({
    name: 'web-1',
    namespace: 'prod',
    labels: { app: 'nginx' },
    spec: { nodeName: 'worker-1', containers: [{ name: 'app', image: 'nginx:1.25' }] },
    status: {
      phase: 'Running',
      containerStatuses: [{ name: 'app', ready: true, restartCount: 2, state: { running: {} } }],
    },
    ...opts,
  });
}

function crashPod(): KubeObject {
  return makeObj({
    name: 'api-1',
    namespace: 'dev',
    spec: { nodeName: 'worker-2', containers: [{ name: 'app', image: 'redis:7' }] },
    status: {
      phase: 'Running',
      containerStatuses: [
        { name: 'app', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } },
      ],
    },
  });
}

function oomPod(): KubeObject {
  return makeObj({
    name: 'batch-1',
    namespace: 'dev',
    spec: { containers: [{ name: 'app', image: 'batcher:1' }] },
    status: {
      phase: 'Running',
      containerStatuses: [
        { name: 'app', ready: false, restartCount: 1, state: { terminated: { reason: 'OOMKilled' } } },
      ],
    },
  });
}

function succeededPod(): KubeObject {
  return makeObj({
    name: 'migrate-abc',
    namespace: 'prod',
    spec: { containers: [{ name: 'job', image: 'migrator:2' }] },
    status: {
      phase: 'Succeeded',
      containerStatuses: [
        { name: 'job', ready: false, restartCount: 0, state: { terminated: { reason: 'Completed' } } },
      ],
    },
  });
}

function deployment(desired: number, ready: number, updated?: number): KubeObject {
  return makeObj({
    name: 'web',
    namespace: 'prod',
    spec: { replicas: desired },
    status: { replicas: desired, readyReplicas: ready, updatedReplicas: updated ?? desired },
  });
}

function makeEvent(): KubeObject {
  return {
    ...makeObj({ name: 'ev-1', namespace: 'prod' }),
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container',
    involvedObject: { kind: 'Pod', name: 'web-1' },
  };
}

function fctx(kind: string, metrics?: FilterContext['metrics']): FilterContext {
  return { kind, nowMs: NOW, metrics };
}

function matches(query: string, obj: KubeObject, ctx: FilterContext, clusterName = 'kind-a'): boolean {
  return matchesSmartFilter({ ctx: clusterName, obj }, parseSmartFilter(query), ctx);
}

describe('parseSmartFilter', () => {
  it('returns no clauses for empty or whitespace input', () => {
    expect(parseSmartFilter('')).toEqual([]);
    expect(parseSmartFilter('   \t ')).toEqual([]);
  });

  it('treats a bare word as a free-text clause', () => {
    expect(parseSmartFilter('nginx')).toEqual([{ op: ':', values: ['nginx'], negated: false }]);
  });

  it('splits whitespace-separated clauses', () => {
    expect(parseSmartFilter('status:crash ns:prod')).toEqual([
      { key: 'status', op: ':', values: ['crash'], negated: false },
      { key: 'ns', op: ':', values: ['prod'], negated: false },
    ]);
  });

  it('lowercases keys but preserves value case', () => {
    expect(parseSmartFilter('STATUS:Crash')).toEqual([
      { key: 'status', op: ':', values: ['Crash'], negated: false },
    ]);
  });

  it('parses all comparison operators', () => {
    expect(parseSmartFilter('restarts>5')).toEqual([{ key: 'restarts', op: '>', values: ['5'], negated: false }]);
    expect(parseSmartFilter('age<1h')).toEqual([{ key: 'age', op: '<', values: ['1h'], negated: false }]);
    expect(parseSmartFilter('age>=2d')).toEqual([{ key: 'age', op: '>=', values: ['2d'], negated: false }]);
    expect(parseSmartFilter('cpu<=100m')).toEqual([{ key: 'cpu', op: '<=', values: ['100m'], negated: false }]);
  });

  it('splits comma values into OR alternatives and drops empties', () => {
    expect(parseSmartFilter('ns:a,b,c')).toEqual([{ key: 'ns', op: ':', values: ['a', 'b', 'c'], negated: false }]);
    expect(parseSmartFilter('ns:a,,b,')).toEqual([{ key: 'ns', op: ':', values: ['a', 'b'], negated: false }]);
  });

  it('negates a clause with a leading bang', () => {
    expect(parseSmartFilter('!ns:prod')).toEqual([{ key: 'ns', op: ':', values: ['prod'], negated: true }]);
  });

  it('negates via a bang on the value and cancels double negation', () => {
    expect(parseSmartFilter('ns:!prod')).toEqual([{ key: 'ns', op: ':', values: ['prod'], negated: true }]);
    expect(parseSmartFilter('!ns:!prod')).toEqual([{ key: 'ns', op: ':', values: ['prod'], negated: false }]);
  });

  it('drops clauses that are still missing a value', () => {
    expect(parseSmartFilter('status:')).toEqual([]);
    expect(parseSmartFilter('status: ns:prod')).toEqual([{ key: 'ns', op: ':', values: ['prod'], negated: false }]);
  });

  it('treats unknown keys as free text', () => {
    expect(parseSmartFilter('foo:bar')).toEqual([{ op: ':', values: ['foo:bar'], negated: false }]);
  });

  it('honors quotes around values with spaces', () => {
    expect(parseSmartFilter('name:"foo bar"')).toEqual([{ key: 'name', op: ':', values: ['foo bar'], negated: false }]);
    expect(parseSmartFilter("name:'a b'")).toEqual([{ key: 'name', op: ':', values: ['a b'], negated: false }]);
    expect(parseSmartFilter('"hello world"')).toEqual([{ op: ':', values: ['hello world'], negated: false }]);
  });

  it('keeps a lone bang as literal free text', () => {
    expect(parseSmartFilter('!')).toEqual([{ op: ':', values: ['!'], negated: false }]);
  });

  it('negates free-text clauses', () => {
    expect(parseSmartFilter('!nginx')).toEqual([{ op: ':', values: ['nginx'], negated: true }]);
  });
});

describe('matchesSmartFilter', () => {
  const pod = fctx('Pod');

  it('matches everything when there are no clauses', () => {
    expect(matches('', healthyPod(), pod)).toBe(true);
  });

  it('matches name substrings case-insensitively', () => {
    expect(matches('name:web', healthyPod(), pod)).toBe(true);
    expect(matches('name:WEB', healthyPod(), pod)).toBe(true);
    expect(matches('name:api', healthyPod(), pod)).toBe(false);
  });

  it('matches namespace via ns and namespace keys', () => {
    expect(matches('ns:pro', healthyPod(), pod)).toBe(true);
    expect(matches('namespace:prod', healthyPod(), pod)).toBe(true);
    expect(matches('ns:dev', healthyPod(), pod)).toBe(false);
  });

  it('matches the cluster context via cluster and ctx keys', () => {
    expect(matches('cluster:kind', healthyPod(), pod, 'kind-a')).toBe(true);
    expect(matches('ctx:kind-a', healthyPod(), pod, 'kind-a')).toBe(true);
    expect(matches('cluster:minikube', healthyPod(), pod, 'kind-a')).toBe(false);
  });

  it('matches kind, falling back to the table kind', () => {
    expect(matches('kind:pod', healthyPod(), pod)).toBe(true);
    expect(matches('kind:po', healthyPod({ kind: 'Pod' }), pod)).toBe(true);
    expect(matches('kind:deploy', healthyPod(), pod)).toBe(false);
  });

  describe('labels and annotations', () => {
    it('matches label presence by key substring', () => {
      expect(matches('label:app', healthyPod(), pod)).toBe(true);
      expect(matches('label:ap', healthyPod(), pod)).toBe(true);
      expect(matches('label:team', healthyPod(), pod)).toBe(false);
    });

    it('matches exact label values case-insensitively', () => {
      expect(matches('label:app=nginx', healthyPod(), pod)).toBe(true);
      expect(matches('label:app=NGINX', healthyPod(), pod)).toBe(true);
      expect(matches('label:app=redis', healthyPod(), pod)).toBe(false);
      expect(matches('label:app=ngi', healthyPod(), pod)).toBe(false);
    });

    it('supports * globs in label values', () => {
      expect(matches('label:app=ng*', healthyPod(), pod)).toBe(true);
      expect(matches('label:app=*inx', healthyPod(), pod)).toBe(true);
      expect(matches('label:app=n*x', healthyPod(), pod)).toBe(true);
      expect(matches('label:app=zz*', healthyPod(), pod)).toBe(false);
    });

    it('never matches labels on objects without a label map', () => {
      expect(matches('label:app', makeObj(), pod)).toBe(false);
    });

    it('matches annotations the same way', () => {
      const obj = makeObj({ annotations: { 'kubus.dev/owner': 'team-a' } });
      expect(matches('annotation:owner', obj, pod)).toBe(true);
      expect(matches('annotation:kubus.dev/owner=team-a', obj, pod)).toBe(true);
      expect(matches('annotation:kubus.dev/owner=team-b', obj, pod)).toBe(false);
    });
  });

  it('matches the scheduled node and honors negation', () => {
    expect(matches('node:worker', healthyPod(), pod)).toBe(true);
    expect(matches('node:worker-2', healthyPod(), pod)).toBe(false);
    expect(matches('!node:worker-1', healthyPod(), pod)).toBe(false);
    expect(matches('!node:worker-2', healthyPod(), pod)).toBe(true);
  });

  it('matches container and init-container images', () => {
    expect(matches('image:nginx', healthyPod(), pod)).toBe(true);
    expect(matches('image:redis', healthyPod(), pod)).toBe(false);
    const withInit = makeObj({
      spec: { containers: [{ image: 'app:1' }], initContainers: [{ image: 'busybox:1' }] },
    });
    expect(matches('image:busybox', withInit, pod)).toBe(true);
  });

  describe('status', () => {
    it('matches the display status text by substring', () => {
      expect(matches('status:running', healthyPod(), pod)).toBe(true);
      expect(matches('status:run', healthyPod(), pod)).toBe(true);
      expect(matches('status:crashloopbackoff', crashPod(), pod)).toBe(true);
      expect(matches('status:pending', healthyPod(), pod)).toBe(false);
    });

    it('resolves the crash alias', () => {
      expect(matches('status:crash', crashPod(), pod)).toBe(true);
      expect(matches('status:crash', healthyPod(), pod)).toBe(false);
    });

    it('resolves the oom alias', () => {
      expect(matches('status:oom', oomPod(), pod)).toBe(true);
      expect(matches('status:oom', crashPod(), pod)).toBe(false);
    });

    it('resolves the error alias for backoffs and failures', () => {
      expect(matches('status:error', crashPod(), pod)).toBe(true);
      expect(matches('status:error', makeObj({ status: { phase: 'Failed' } }), pod)).toBe(true);
      expect(matches('status:error', oomPod(), pod)).toBe(false);
      expect(matches('status:error', healthyPod(), pod)).toBe(false);
    });

    it('resolves completed for succeeded pods', () => {
      expect(matches('status:completed', succeededPod(), pod)).toBe(true);
      expect(matches('status:completed', healthyPod(), pod)).toBe(false);
    });

    it('resolves healthy / ok / unhealthy', () => {
      expect(matches('status:healthy', healthyPod(), pod)).toBe(true);
      expect(matches('status:ok', healthyPod(), pod)).toBe(true);
      expect(matches('status:unhealthy', healthyPod(), pod)).toBe(false);
      expect(matches('status:unhealthy', crashPod(), pod)).toBe(true);
      expect(matches('status:healthy', succeededPod(), pod)).toBe(true);
    });

    it('resolves degraded and progressing for workloads', () => {
      const deploy = fctx('Deployment');
      expect(matches('status:degraded', deployment(3, 1, 3), deploy)).toBe(true);
      expect(matches('status:progressing', deployment(3, 1, 1), deploy)).toBe(true);
      expect(matches('status:degraded', deployment(3, 1, 1), deploy)).toBe(false);
      expect(matches('status:running', deployment(3, 3), deploy)).toBe(true);
      expect(matches('status:scaled', deployment(0, 0), deploy)).toBe(true);
    });

    it('reports suspended CronJobs', () => {
      const cron = fctx('CronJob');
      expect(matches('status:suspended', makeObj({ spec: { suspend: true } }), cron)).toBe(true);
      expect(matches('status:active', makeObj({ spec: { suspend: false } }), cron)).toBe(true);
    });
  });

  describe('ready', () => {
    it('checks pod readiness', () => {
      expect(matches('ready:true', healthyPod(), pod)).toBe(true);
      expect(matches('ready:false', healthyPod(), pod)).toBe(false);
      expect(matches('ready:false', crashPod(), pod)).toBe(true);
    });

    it('checks workload readiness and treats zero desired as not ready', () => {
      const deploy = fctx('Deployment');
      expect(matches('ready:true', deployment(3, 3), deploy)).toBe(true);
      expect(matches('ready:true', deployment(3, 1), deploy)).toBe(false);
      expect(matches('ready:false', deployment(0, 0), deploy)).toBe(true);
    });
  });

  describe('restarts', () => {
    it('compares the summed restart count', () => {
      const p = crashPod(); // 7 restarts
      expect(matches('restarts>5', p, pod)).toBe(true);
      expect(matches('restarts>7', p, pod)).toBe(false);
      expect(matches('restarts>=7', p, pod)).toBe(true);
      expect(matches('restarts<=7', p, pod)).toBe(true);
      expect(matches('restarts<3', p, pod)).toBe(false);
      expect(matches('restarts:7', p, pod)).toBe(true);
    });

    it('rejects rows for non-numeric values', () => {
      expect(matches('restarts>abc', crashPod(), pod)).toBe(false);
    });
  });

  it('compares desired replicas for workloads', () => {
    const deploy = fctx('Deployment');
    expect(matches('replicas:3', deployment(3, 3), deploy)).toBe(true);
    expect(matches('replicas>2', deployment(3, 3), deploy)).toBe(true);
    expect(matches('replicas>3', deployment(3, 3), deploy)).toBe(false);
    expect(matches('replicas<5', deployment(3, 3), deploy)).toBe(true);
    expect(matches('replicas>0', healthyPod(), pod)).toBe(false);
  });

  describe('age', () => {
    const threeDays = healthyPod({ ageSeconds: 3 * 86400 });

    it('compares against duration values', () => {
      expect(matches('age>2d', threeDays, pod)).toBe(true);
      expect(matches('age<1w', threeDays, pod)).toBe(true);
      expect(matches('age>1w', threeDays, pod)).toBe(false);
      expect(matches('age>=3d', threeDays, pod)).toBe(true);
      expect(matches('age>3d', threeDays, pod)).toBe(false);
      expect(matches('age>2.5d', threeDays, pod)).toBe(true);
      expect(matches('age>48h', threeDays, pod)).toBe(true);
      expect(matches('age<90m', threeDays, pod)).toBe(false);
    });

    it('defaults bare numbers to seconds', () => {
      expect(matches('age>259100', threeDays, pod)).toBe(true);
      expect(matches('age<259100', threeDays, pod)).toBe(false);
    });

    it('rejects malformed durations and missing timestamps', () => {
      expect(matches('age>xyz', threeDays, pod)).toBe(false);
      expect(matches('age>1h', healthyPod(), pod)).toBe(false);
    });
  });

  describe('cpu / mem via metrics', () => {
    const metrics: FilterContext['metrics'] = () => ({
      cpuMilli: 250,
      memBytes: 512 * 2 ** 20,
      cpuCapacityMilli: 1000,
      memCapacityBytes: 1024 * 2 ** 20,
    });
    const podWithMetrics = fctx('Pod', metrics);

    it('compares cpu quantities in millicores', () => {
      expect(matches('cpu>100m', healthyPod(), podWithMetrics)).toBe(true);
      expect(matches('cpu>1', healthyPod(), podWithMetrics)).toBe(false);
      expect(matches('cpu<1', healthyPod(), podWithMetrics)).toBe(true);
      expect(matches('cpu>=250m', healthyPod(), podWithMetrics)).toBe(true);
      expect(matches('cpu>250m', healthyPod(), podWithMetrics)).toBe(false);
    });

    it('compares memory quantities in bytes', () => {
      expect(matches('mem>256Mi', healthyPod(), podWithMetrics)).toBe(true);
      expect(matches('mem<1Gi', healthyPod(), podWithMetrics)).toBe(true);
      expect(matches('memory>1Gi', healthyPod(), podWithMetrics)).toBe(false);
    });

    it('compares percentages against capacity', () => {
      expect(matches('cpu>20%', healthyPod(), podWithMetrics)).toBe(true); // 25%
      expect(matches('cpu>30%', healthyPod(), podWithMetrics)).toBe(false);
      expect(matches('mem>=50%', healthyPod(), podWithMetrics)).toBe(true); // exactly 50%
      expect(matches('mem>50%', healthyPod(), podWithMetrics)).toBe(false);
    });

    it('rejects rows without metrics or with malformed values', () => {
      expect(matches('cpu>100m', healthyPod(), pod)).toBe(false);
      expect(matches('cpu>x%', healthyPod(), podWithMetrics)).toBe(false);
      const noCapacity: FilterContext['metrics'] = () => ({ cpuMilli: 250, memBytes: 1 });
      expect(matches('cpu>20%', healthyPod(), fctx('Pod', noCapacity))).toBe(false);
    });
  });

  describe('service and event type', () => {
    const svc = fctx('Service');

    it('resolves service type aliases', () => {
      const lb = makeObj({ spec: { type: 'LoadBalancer' } });
      expect(matches('type:lb', lb, svc)).toBe(true);
      expect(matches('type:loadbalancer', lb, svc)).toBe(true);
      expect(matches('type:load', lb, svc)).toBe(true);
      expect(matches('type:np', lb, svc)).toBe(false);
    });

    it('defaults services to ClusterIP', () => {
      const plain = makeObj({ spec: {} });
      expect(matches('type:cluster', plain, svc)).toBe(true);
      expect(matches('type:clusterip', plain, svc)).toBe(true);
      expect(matches('type:external', makeObj({ spec: { type: 'ExternalName' } }), svc)).toBe(true);
    });

    it('matches the event type field for other kinds', () => {
      expect(matches('type:warn', makeEvent(), fctx('Event'))).toBe(true);
      expect(matches('type:normal', makeEvent(), fctx('Event'))).toBe(false);
    });
  });

  it('matches event reason and message', () => {
    const ev = fctx('Event');
    expect(matches('reason:backoff', makeEvent(), ev)).toBe(true);
    expect(matches('reason:pulled', makeEvent(), ev)).toBe(false);
    expect(matches('message:restarting', makeEvent(), ev)).toBe(true);
    expect(matches('message:mounted', makeEvent(), ev)).toBe(false);
  });

  describe('free text', () => {
    it('searches name, namespace, cluster, status and labels', () => {
      expect(matches('web', healthyPod(), pod)).toBe(true);
      expect(matches('prod', healthyPod(), pod)).toBe(true);
      expect(matches('kind-a', healthyPod(), pod)).toBe(true);
      expect(matches('running', healthyPod(), pod)).toBe(true);
      expect(matches('app=nginx', healthyPod(), pod)).toBe(true);
      expect(matches('zzz', healthyPod(), pod)).toBe(false);
    });

    it('includes node and images for pods', () => {
      expect(matches('worker-1', healthyPod(), pod)).toBe(true);
      expect(matches('nginx:1.25', healthyPod(), pod)).toBe(true);
      expect(matches('worker-1', deployment(1, 1), fctx('Deployment'))).toBe(false);
    });

    it('honors negated free text', () => {
      expect(matches('!redis', healthyPod(), pod)).toBe(true);
      expect(matches('!nginx', healthyPod(), pod)).toBe(false);
    });
  });

  it('ORs comma alternatives within a clause', () => {
    expect(matches('ns:staging,prod', healthyPod(), pod)).toBe(true);
    expect(matches('ns:staging,dev', healthyPod(), pod)).toBe(false);
    expect(matches('!ns:staging,prod', healthyPod(), pod)).toBe(false);
    expect(matches('!ns:staging,qa', healthyPod(), pod)).toBe(true);
  });

  it('ANDs separate clauses', () => {
    expect(matches('name:web ns:prod', healthyPod(), pod)).toBe(true);
    expect(matches('name:web ns:dev', healthyPod(), pod)).toBe(false);
    expect(matches('status:crash restarts>5', crashPod(), pod)).toBe(true);
    expect(matches('status:crash restarts>9', crashPod(), pod)).toBe(false);
  });
});

describe('matchesPlainText', () => {
  it('requires every word to appear in the haystack', () => {
    const row = { ctx: 'kind-a', obj: healthyPod() };
    expect(matchesPlainText(row, ['web', 'prod'], 'Pod')).toBe(true);
    expect(matchesPlainText(row, ['web', 'missing'], 'Pod')).toBe(false);
    expect(matchesPlainText(row, [], 'Pod')).toBe(true);
    expect(matchesPlainText(row, ['app=nginx'], 'Pod')).toBe(true);
    expect(matchesPlainText(row, ['worker-1'], 'Pod')).toBe(true);
  });
});

describe('smartFilterSuggestions', () => {
  const none = () => [];

  it('lists keys for the current kind on empty input, capped at 12', () => {
    const out = smartFilterSuggestions('', 'Pod', none);
    expect(out).toHaveLength(12);
    const completions = out.map((s) => s.completion);
    expect(completions).toContain('status:');
    expect(completions).toContain('restarts>');
    expect(completions).toContain('node:');
    expect(completions).toContain('image:');
    expect(completions).not.toContain('type:');
    expect(completions).not.toContain('replicas>');
  });

  it('filters keys by kind', () => {
    const deploy = smartFilterSuggestions('', 'Deployment', none).map((s) => s.completion);
    expect(deploy).toContain('replicas>');
    expect(deploy).toContain('ready:');
    expect(deploy).not.toContain('restarts>');
    expect(deploy).not.toContain('image:');

    const svc = smartFilterSuggestions('', 'Service', none).map((s) => s.completion);
    expect(svc).toContain('type:');
    expect(svc).not.toContain('ready:');

    const ev = smartFilterSuggestions('', 'Event', none).map((s) => s.completion);
    expect(ev).toContain('reason:');
    expect(ev).toContain('message:');
  });

  it('completes partial keys', () => {
    const out = smartFilterSuggestions('sta', 'Pod', none);
    expect(out.map((s) => s.completion)).toEqual(['status:']);
    expect(smartFilterSuggestions('age', 'Pod', none).map((s) => s.completion)).toEqual(['age>', 'age<']);
    expect(smartFilterSuggestions('r', 'Pod', none).map((s) => s.completion)).toEqual(['restarts>', 'ready:']);
  });

  it('lists static values after a key', () => {
    const out = smartFilterSuggestions('status:', 'Pod', none);
    expect(out).toHaveLength(9);
    expect(out.map((s) => s.completion)).toContain('status:crash');
    expect(smartFilterSuggestions('ready:', 'Pod', none).map((s) => s.completion)).toEqual([
      'ready:true',
      'ready:false',
    ]);
  });

  it('filters values by the typed partial and carries hints', () => {
    expect(smartFilterSuggestions('status:cr', 'Pod', none)).toEqual([
      { completion: 'status:crash', hint: 'CrashLoopBackOff' },
    ]);
    expect(smartFilterSuggestions('type:l', 'Service', none)).toEqual([
      { completion: 'type:lb', hint: 'LoadBalancer' },
    ]);
  });

  it('drops the value already fully typed', () => {
    expect(smartFilterSuggestions('status:crash', 'Pod', none)).toEqual([]);
  });

  it('merges dynamic values', () => {
    const dyn = (key: string) => (key === 'ns' ? ['prod', 'dev', 'print'] : []);
    expect(smartFilterSuggestions('ns:', 'Pod', dyn).map((s) => s.completion)).toEqual([
      'ns:prod',
      'ns:dev',
      'ns:print',
    ]);
    expect(smartFilterSuggestions('ns:pr', 'Pod', dyn).map((s) => s.completion)).toEqual(['ns:prod', 'ns:print']);
    expect(smartFilterSuggestions('ns:prod', 'Pod', dyn).map((s) => s.completion)).toEqual([]);
  });

  it('preserves earlier clauses and negation in completions', () => {
    const dyn = (key: string) => (key === 'ns' ? ['prod'] : []);
    expect(smartFilterSuggestions('status:crash ns:', 'Pod', dyn).map((s) => s.completion)).toEqual([
      'status:crash ns:prod',
    ]);
    expect(smartFilterSuggestions('!ns:', 'Pod', dyn).map((s) => s.completion)).toEqual(['!ns:prod']);
    expect(smartFilterSuggestions('!sta', 'Pod', none).map((s) => s.completion)).toEqual(['!status:']);
  });

  it('caps value suggestions at 12', () => {
    const dyn = () => Array.from({ length: 20 }, (_, i) => `node-${i}`);
    expect(smartFilterSuggestions('node:', 'Pod', dyn)).toHaveLength(12);
  });

  it('suggests nothing for unknown keys', () => {
    expect(smartFilterSuggestions('foo:', 'Pod', none)).toEqual([]);
  });
});
