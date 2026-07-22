import { describe, expect, it } from 'vitest';
import { evalPrinterColumnPath } from '@kubus/shared';

const pod = {
  metadata: {
    name: 'web-0',
    labels: { 'app.kubernetes.io/name': 'web', tier: 'frontend' },
    annotations: { 'kubus.dev/owner': 'platform' },
  },
  spec: {
    replicas: 3,
    containers: [
      { name: 'app', image: 'nginx:1.27' },
      { name: 'sidecar', image: 'envoy:1.30' },
    ],
  },
  status: {
    phase: 'Running',
    conditions: [
      { type: 'Initialized', status: 'True' },
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
    ],
  },
};

describe('evalPrinterColumnPath', () => {
  describe('dot segments', () => {
    it('resolves nested dot paths', () => {
      expect(evalPrinterColumnPath(pod, '.metadata.name')).toBe('web-0');
      expect(evalPrinterColumnPath(pod, '.status.phase')).toBe('Running');
    });

    it('returns a single non-string leaf as-is', () => {
      expect(evalPrinterColumnPath(pod, '.spec.replicas')).toBe(3);
    });

    it('returns a single object leaf by identity', () => {
      expect(evalPrinterColumnPath(pod, '.metadata.labels')).toBe(pod.metadata.labels);
    });

    it('accepts kubectl-style braces and a $ prefix', () => {
      expect(evalPrinterColumnPath(pod, '{.metadata.name}')).toBe('web-0');
      expect(evalPrinterColumnPath(pod, '$.metadata.name')).toBe('web-0');
    });

    it('tolerates a bare leading key without a dot', () => {
      expect(evalPrinterColumnPath(pod, 'metadata.name')).toBe('web-0');
    });
  });

  describe('numeric indices', () => {
    it('indexes into arrays', () => {
      expect(evalPrinterColumnPath(pod, '.spec.containers[0].name')).toBe('app');
      expect(evalPrinterColumnPath(pod, '.spec.containers[1].image')).toBe('envoy:1.30');
    });

    it('returns undefined for out-of-range indices', () => {
      expect(evalPrinterColumnPath(pod, '.spec.containers[5].name')).toBeUndefined();
    });

    it('returns undefined when indexing a non-array', () => {
      expect(evalPrinterColumnPath(pod, '.metadata[0]')).toBeUndefined();
    });
  });

  describe('quoted keys', () => {
    it('resolves keys containing dots and slashes', () => {
      expect(evalPrinterColumnPath(pod, ".metadata.labels['app.kubernetes.io/name']")).toBe('web');
      expect(evalPrinterColumnPath(pod, '.metadata.annotations["kubus.dev/owner"]')).toBe('platform');
    });

    it('supports chained quoted keys', () => {
      expect(evalPrinterColumnPath(pod, ".metadata['labels']['tier']")).toBe('frontend');
    });

    it('returns undefined for a missing quoted key', () => {
      expect(evalPrinterColumnPath(pod, ".metadata.labels['no.such/key']")).toBeUndefined();
    });
  });

  describe('wildcards', () => {
    it('joins multiple array results with commas', () => {
      expect(evalPrinterColumnPath(pod, '.spec.containers[*].name')).toBe('app,sidecar');
    });

    it('unwraps a single wildcard result without joining', () => {
      const svc = { spec: { ports: [{ port: 80 }] } };
      expect(evalPrinterColumnPath(svc, '.spec.ports[*].port')).toBe(80);
    });

    it('iterates object values with .* and [*]', () => {
      const cm = { data: { a: 'x', b: 'y' } };
      expect(evalPrinterColumnPath(cm, '.data.*')).toBe('x,y');
      expect(evalPrinterColumnPath(cm, '.data[*]')).toBe('x,y');
    });

    it('stringifies object results when joining', () => {
      expect(evalPrinterColumnPath({ items: [{ a: 1 }, { b: 'x' }] }, '.items[*]')).toBe('{"a":1},{"b":"x"}');
    });

    it('stringifies numbers and booleans when joining', () => {
      expect(evalPrinterColumnPath({ ports: [{ port: 80 }, { port: 443 }] }, '.ports[*].port')).toBe('80,443');
      expect(evalPrinterColumnPath({ flags: [true, false] }, '.flags[*]')).toBe('true,false');
    });

    it('drops null entries from wildcard results', () => {
      expect(evalPrinterColumnPath({ xs: [1, null, 2] }, '.xs[*]')).toBe('1,2');
    });

    it('returns undefined for a wildcard on a scalar', () => {
      expect(evalPrinterColumnPath(pod, '.metadata.name[*]')).toBeUndefined();
    });
  });

  describe('equality filters', () => {
    it('selects condition entries by type', () => {
      expect(evalPrinterColumnPath(pod, '.status.conditions[?(@.type=="Ready")].status')).toBe('False');
      expect(evalPrinterColumnPath(pod, ".status.conditions[?(@.type=='Ready')].reason")).toBe('ContainersNotReady');
    });

    it('returns a single matching element by identity', () => {
      expect(evalPrinterColumnPath(pod, '.status.conditions[?(@.type=="Ready")]')).toBe(pod.status.conditions[1]);
    });

    it('tolerates whitespace inside the filter', () => {
      expect(evalPrinterColumnPath(pod, '.status.conditions[?( @.type == "Ready" )].status')).toBe('False');
    });

    it('supports nested paths after @', () => {
      const vs = {
        routes: [
          { match: { host: 'a' }, dest: 'x' },
          { match: { host: 'b' }, dest: 'y' },
        ],
      };
      expect(evalPrinterColumnPath(vs, '.routes[?(@.match.host=="b")].dest')).toBe('y');
    });

    it('coerces numbers and booleans for comparison', () => {
      const svc = { ports: [{ port: 80, name: 'http' }, { port: 443, name: 'https' }] };
      expect(evalPrinterColumnPath(svc, '.ports[?(@.port=="443")].name')).toBe('https');
      expect(evalPrinterColumnPath({ conds: [{ ok: true, msg: 'up' }] }, '.conds[?(@.ok=="true")].msg')).toBe('up');
    });

    it('joins multiple filter matches', () => {
      const obj = { conditions: [{ type: 'Ready', status: 'True' }, { type: 'Ready', status: 'False' }] };
      expect(evalPrinterColumnPath(obj, '.conditions[?(@.type=="Ready")].status')).toBe('True,False');
    });

    it('returns undefined when nothing matches', () => {
      expect(evalPrinterColumnPath(pod, '.status.conditions[?(@.type=="Synced")].status')).toBeUndefined();
    });

    it('returns undefined when filtering a non-array', () => {
      expect(evalPrinterColumnPath(pod, '.metadata[?(@.name=="web-0")]')).toBeUndefined();
    });
  });

  describe('nested combinations', () => {
    it('combines dot paths, wildcards, and sparse keys', () => {
      const svc = { status: { loadBalancer: { ingress: [{ ip: '10.0.0.1' }, { hostname: 'lb.example' }] } } };
      expect(evalPrinterColumnPath(svc, '.status.loadBalancer.ingress[*].ip')).toBe('10.0.0.1');
    });

    it('combines indices and filters', () => {
      const obj = { items: [{ conds: [{ type: 'Ready', status: 'True' }] }] };
      expect(evalPrinterColumnPath(obj, '.items[0].conds[?(@.type=="Ready")].status')).toBe('True');
    });
  });

  describe('missing keys and nullish values', () => {
    it('returns undefined for missing keys at any depth', () => {
      expect(evalPrinterColumnPath(pod, '.metadata.missing')).toBeUndefined();
      expect(evalPrinterColumnPath(pod, '.missing.deeper.path')).toBeUndefined();
    });

    it('returns undefined for null leaves and nullish roots', () => {
      expect(evalPrinterColumnPath({ a: { b: null } }, '.a.b')).toBeUndefined();
      expect(evalPrinterColumnPath(null, '.a')).toBeUndefined();
      expect(evalPrinterColumnPath(undefined, '.a')).toBeUndefined();
    });

    it('returns undefined for a dot key applied to an array', () => {
      expect(evalPrinterColumnPath(pod, '.spec.containers.name')).toBeUndefined();
    });
  });

  describe('malformed expressions', () => {
    it('returns undefined for an unclosed bracket', () => {
      expect(evalPrinterColumnPath(pod, '.spec.containers[0')).toBeUndefined();
    });

    it('returns undefined for an unquoted bracket key', () => {
      expect(evalPrinterColumnPath(pod, '.spec.containers[abc]')).toBeUndefined();
    });

    it('returns undefined for unsupported filter operators', () => {
      expect(evalPrinterColumnPath(pod, '.status.conditions[?(@.type!="Ready")]')).toBeUndefined();
      expect(evalPrinterColumnPath(pod, '.status.conditions[?(@.type)]')).toBeUndefined();
    });

    it('returns undefined for an unquoted filter value', () => {
      expect(evalPrinterColumnPath(pod, '.status.conditions[?(@.type==Ready)]')).toBeUndefined();
    });
  });

  describe('parse cache', () => {
    it('evaluates the same path against different objects', () => {
      const path = '.metadata.name';
      expect(evalPrinterColumnPath({ metadata: { name: 'a' } }, path)).toBe('a');
      expect(evalPrinterColumnPath({ metadata: { name: 'b' } }, path)).toBe('b');
      expect(evalPrinterColumnPath({ metadata: { name: 'a' } }, path)).toBe('a');
    });

    it('keeps returning undefined for a cached malformed path', () => {
      const bad = '.spec.containers[oops';
      expect(evalPrinterColumnPath(pod, bad)).toBeUndefined();
      expect(evalPrinterColumnPath(pod, bad)).toBeUndefined();
    });

    it('reuses cached filter segments without corruption', () => {
      const path = '.status.conditions[?(@.type=="Ready")].status';
      expect(evalPrinterColumnPath(pod, path)).toBe('False');
      // Interleave other paths, then re-evaluate the cached one.
      expect(evalPrinterColumnPath(pod, '.metadata.name')).toBe('web-0');
      expect(evalPrinterColumnPath(pod, '.bad[')).toBeUndefined();
      expect(evalPrinterColumnPath(pod, path)).toBe('False');
    });
  });
});
