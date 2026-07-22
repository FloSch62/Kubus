import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  type HelmReleasePayload,
  type ReleaseRecord,
  chartCrdNames,
  decodeReleaseRecord,
  encodeReleasePayload,
  revOf,
} from '../../../server/src/helm/release-reader.js';
import { HttpProblem } from '../../../server/src/util/errors.js';

function payload(over: Partial<HelmReleasePayload> = {}): HelmReleasePayload {
  return {
    name: 'demo',
    namespace: 'default',
    version: 1,
    info: { status: 'deployed', first_deployed: '2026-07-01T10:00:00Z', last_deployed: '2026-07-01T10:00:00Z', notes: 'Enjoy!' },
    chart: {
      metadata: { name: 'demo-chart', version: '1.2.3', appVersion: '4.5.6' },
      values: { replicaCount: 1, image: { tag: 'latest' } },
    },
    config: { replicaCount: 2 },
    manifest: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n',
    ...over,
  };
}

// The decode cache is keyed by name+resourceVersion, so records get unique names per test.
function record(name: string, driver: ReleaseRecord['driver'], p: HelmReleasePayload, resourceVersion = '1'): ReleaseRecord {
  const encoded = encodeReleasePayload(p);
  return {
    driver,
    metadata: { name, namespace: 'default', resourceVersion },
    data: { release: driver === 'secret' ? Buffer.from(encoded, 'utf8').toString('base64') : encoded },
  };
}

const crdYaml = (...names: string[]) =>
  names
    .map((n) => `apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: ${n}\n`)
    .join('---\n');

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('encodeReleasePayload', () => {
  it('produces base64(gzip(JSON)) of the payload', () => {
    const p = payload();
    const encoded = encodeReleasePayload(p);
    const decoded = JSON.parse(zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
    expect(decoded).toEqual(p);
  });
});

describe('decodeReleaseRecord', () => {
  it('round-trips a configmap-driver record', () => {
    const p = payload({ version: 3 });
    expect(decodeReleaseRecord(record('sh.helm.release.v1.cm-rt.v3', 'configmap', p))).toEqual(p);
  });

  it('round-trips a secret-driver record through the extra base64 layer', () => {
    const p = payload({ version: 2, kubus: { computedValues: { replicaCount: 2, image: { tag: 'latest' } } } });
    expect(decodeReleaseRecord(record('sh.helm.release.v1.sec-rt.v2', 'secret', p))).toEqual(p);
  });

  it('rejects a record without data.release as a 422', () => {
    const bare: ReleaseRecord = { driver: 'secret', metadata: { name: 'sh.helm.release.v1.bare.v1', namespace: 'default' } };
    let caught: unknown;
    try {
      decodeReleaseRecord(bare);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpProblem);
    expect((caught as HttpProblem).statusCode).toBe(422);
  });

  it('throws on data that is not gzipped', () => {
    const bad: ReleaseRecord = {
      driver: 'configmap',
      metadata: { name: 'sh.helm.release.v1.corrupt.v1', namespace: 'default', resourceVersion: '1' },
      data: { release: b64('not gzip at all') },
    };
    expect(() => decodeReleaseRecord(bad)).toThrow();
  });

  it('serves repeat decodes of the same record from the cache', () => {
    const rec = record('sh.helm.release.v1.cached.v1', 'configmap', payload());
    const first = decodeReleaseRecord(rec);
    expect(decodeReleaseRecord(rec)).toBe(first);
  });

  it('decodes fresh when the resourceVersion changes', () => {
    const name = 'sh.helm.release.v1.rv-change.v1';
    const first = decodeReleaseRecord(record(name, 'configmap', payload({ info: { status: 'deployed' } }), '10'));
    const second = decodeReleaseRecord(record(name, 'configmap', payload({ info: { status: 'superseded' } }), '11'));
    expect(first.info?.status).toBe('deployed');
    expect(second.info?.status).toBe('superseded');
  });
});

describe('chartCrdNames', () => {
  it('extracts CRD names from crds/ files, sorted', () => {
    const p = payload({
      chart: {
        metadata: { name: 'demo-chart', version: '1.2.3' },
        files: [
          { name: 'crds/widgets.yaml', data: b64(crdYaml('widgets.example.com')) },
          { name: 'crds/more.yaml', data: b64(crdYaml('gadgets.example.com', 'gizmos.example.com')) },
        ],
      },
    });
    expect(chartCrdNames(p)).toEqual(['gadgets.example.com', 'gizmos.example.com', 'widgets.example.com']);
  });

  it('ignores non-crds files, non-CRD documents, and files without data', () => {
    const p = payload({
      chart: {
        metadata: { name: 'demo-chart' },
        files: [
          { name: 'templates/deployment.yaml', data: b64(crdYaml('sneaky.example.com')) },
          { name: 'crds/README.md', data: b64('kind: ConfigMap\nmetadata:\n  name: not-a-crd\n') },
          { name: 'crds/empty.yaml' },
          { name: 'crds/real.yaml', data: b64(crdYaml('real.example.com')) },
        ],
      },
    });
    expect(chartCrdNames(p)).toEqual(['real.example.com']);
  });

  it('skips unparsable crds files without losing the rest', () => {
    const p = payload({
      chart: {
        metadata: { name: 'demo-chart' },
        files: [
          { name: 'crds/broken.yaml', data: b64('a: [unclosed') },
          { name: 'crds/ok.yaml', data: b64(crdYaml('ok.example.com')) },
        ],
      },
    });
    expect(chartCrdNames(p)).toEqual(['ok.example.com']);
  });

  it('returns an empty list when the chart ships no files', () => {
    expect(chartCrdNames(payload())).toEqual([]);
    expect(chartCrdNames(payload({ chart: undefined }))).toEqual([]);
  });
});

describe('revOf', () => {
  it('reads the revision from the record name suffix', () => {
    expect(revOf({ metadata: { name: 'sh.helm.release.v1.myapp.v12' } })).toBe(12);
    expect(revOf({ metadata: { name: 'sh.helm.release.v1.myapp.v1' } })).toBe(1);
  });

  it('handles release names containing dots', () => {
    expect(revOf({ metadata: { name: 'sh.helm.release.v1.my.app.v2' } })).toBe(2);
  });

  it('returns 0 when there is no revision suffix', () => {
    expect(revOf({ metadata: { name: 'not-a-release-record' } })).toBe(0);
  });
});
