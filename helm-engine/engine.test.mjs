import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { inspectChart, renderChart } from '../server/dist/helm/engine.js';

// Build a small, deterministic chart archive without a Helm CLI or a cluster.
function archive(files) {
  const blocks = [];
  for (const [name, source] of Object.entries(files)) {
    const data = Buffer.from(source);
    const header = Buffer.alloc(512);
    header.write(`compat/${name}`);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(' ', 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks)).toString('base64');
}

const valuesYaml = '# Preserve comments when inspecting values.\nreplicas: 2\nchild:\n  enabled: true\n';
const template = `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}
  namespace: {{ .Release.Namespace }}
data:
  replicas: {{ .Values.replicas | quote }}
  revision: {{ .Release.Revision | quote }}
  install: {{ .Release.IsInstall | quote }}
  upgrade: {{ .Release.IsUpgrade | quote }}
  kube: {{ .Capabilities.KubeVersion.Version | quote }}
  api: {{ .Capabilities.APIVersions.Has "example.com/v1/Widget" | quote }}
`;
const schema = JSON.stringify({
  type: 'object',
  required: ['replicas'],
  properties: { replicas: { type: 'integer', minimum: 1 } },
});
const files = {
  'Chart.yaml': `apiVersion: v2
name: compat
version: 1.0.0
dependencies:
  - name: child
    version: 1.0.0
    repository: file://charts/child
    condition: child.enabled
`,
  'values.yaml': valuesYaml,
  'values.schema.json': schema,
  'README.md': '# Compatibility chart\n',
  'templates/configmap.yaml': template,
  'templates/NOTES.txt': 'Installed {{ .Release.Name }} in {{ .Release.Namespace }}',
  'templates/hook.yaml': `apiVersion: batch/v1
kind: Job
metadata:
  name: before-install
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-2"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec: {}
`,
  'crds/widgets.yaml': `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com
spec: {}
`,
  'charts/child/Chart.yaml': 'apiVersion: v2\nname: child\nversion: 1.0.0\n',
  'charts/child/values.yaml': 'message: child-default\n',
  'charts/child/templates/configmap.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: child-config
data:
  message: {{ .Values.message | quote }}
`,
  'charts/child/templates/NOTES.txt': 'Child notes must not leak into the parent notes.',
};
const chartArchive = archive(files);
const release = { name: 'demo', namespace: 'sandbox', revision: 1, isInstall: true };
const capabilities = { kubeVersion: 'v1.35.0', apiVersions: ['v1', 'example.com/v1/Widget'] };

await test('inspects a chart archive through the WASM host, preserving values comments and README', async () => {
  const result = await inspectChart(chartArchive);
  assert.equal(result.metadata.name, 'compat');
  assert.equal(result.metadata.version, '1.0.0');
  assert.equal(result.values.replicas, 2);
  assert.equal(result.valuesYaml, valuesYaml);
  assert.equal(result.readme, files['README.md']);
});

await test('renders defaults, overrides, subcharts, release options and cluster capabilities', async () => {
  const result = await renderChart({ chartArchive, values: { replicas: 3 }, release, ...capabilities });
  for (const field of ['replicas: "3"', 'revision: "1"', 'install: "true"', 'upgrade: "false"', 'kube: "v1.35.0"', 'api: "true"']) {
    assert.ok(result.manifest.includes(field), field);
  }
  assert.match(result.manifest, /name: child-config/);
  assert.match(result.manifest, /message: "child-default"/);
  assert.equal(result.computedValues.replicas, 3);
  assert.equal(result.computedValues.child.message, 'child-default');
  assert.equal(result.metadata.name, 'compat');
  assert.equal(result.chartJSON.metadata.apiVersion, 'v2');
});

await test('keeps hooks, top-level notes and CRDs separate from ordinary manifests', async () => {
  const result = await renderChart({ chartArchive, values: {}, release });
  assert.equal(result.notes, 'Installed demo in sandbox');
  assert.doesNotMatch(result.manifest, /before-install|CustomResourceDefinition|notes/i);
  assert.equal(result.hooks.length, 1);
  assert.equal(result.hooks[0].name, 'before-install');
  assert.equal(result.hooks[0].kind, 'Job');
  assert.equal(result.hooks[0].path, 'compat/templates/hook.yaml');
  assert.equal(result.hooks[0].weight, -2);
  assert.deepEqual(result.hooks[0].events, ['pre-install', 'pre-upgrade']);
  assert.deepEqual(result.hooks[0].delete_policies, ['before-hook-creation', 'hook-succeeded']);
  assert.deepEqual(result.crds, [{ name: 'crds/widgets.yaml', content: files['crds/widgets.yaml'] }]);
});

await test('honors subchart dependency conditions', async () => {
  const result = await renderChart({ chartArchive, values: { child: { enabled: false } }, release });
  assert.doesNotMatch(result.manifest, /child-config/);
  assert.match(result.manifest, /name: demo/);
});

await test('renders a Helm 3 stored chart and the resulting chart JSON during values-only upgrades', async () => {
  // This is the pre-Helm-4 release payload shape: no new SDK fields or wrappers.
  const chartJSON = {
    metadata: { apiVersion: 'v2', name: 'legacy', version: '1.0.0' },
    templates: [{ name: 'templates/configmap.yaml', data: Buffer.from(template).toString('base64') }],
    values: { replicas: 2 },
    schema: Buffer.from(schema).toString('base64'),
    files: [],
  };
  const options = { ...release, revision: 2, isInstall: false, isUpgrade: true };
  const result = await renderChart({ chartJSON, values: { replicas: 4 }, release: options, ...capabilities });
  assert.match(result.manifest, /replicas: "4"/);
  assert.match(result.manifest, /revision: "2"/);
  assert.match(result.manifest, /install: "false"/);
  assert.match(result.manifest, /upgrade: "true"/);
  assert.deepEqual(result.hooks, []);
  assert.deepEqual(result.crds, []);
  const next = await renderChart({ chartJSON: result.chartJSON, values: { replicas: 5 }, release: { ...options, revision: 3 }, ...capabilities });
  assert.match(next.manifest, /replicas: "5"/);
  assert.match(next.manifest, /revision: "3"/);
});

await test('reports schema violations as a 422 response without breaking later renders', async () => {
  await assert.rejects(
    renderChart({ chartArchive, values: { replicas: 'invalid' }, release }),
    (error) => error.statusCode === 422 && /replicas/.test(error.message),
  );
  const result = await renderChart({ chartArchive, values: { replicas: 1 }, release });
  assert.equal(result.computedValues.replicas, 1);
});

await test('reports malformed archives and Kubernetes versions as a 422 response', async () => {
  await assert.rejects(inspectChart(Buffer.from('not a chart').toString('base64')), { statusCode: 422 });
  await assert.rejects(renderChart({ chartArchive, values: {}, release, kubeVersion: 'invalid' }), { statusCode: 422 });
});

await test('uses the Helm 4 runtime in the compiled artifact', async () => {
  const withVersion = archive({
    ...files,
    'templates/configmap.yaml': `${template}  helm: {{ .Capabilities.HelmVersion.Version | quote }}\n`,
  });
  const result = await renderChart({ chartArchive: withVersion, values: {}, release });
  assert.match(result.manifest, /helm: "v4\./);
});
