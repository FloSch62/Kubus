import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { renderChart, inspectChart } from '../server/dist/helm/engine.js';

const chart = {
  metadata: { apiVersion: 'v2', name: 'smoke', version: '1.0.0' },
  templates: [{ name: 'templates/config.yaml', data: Buffer.from('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\ndata:\n  greeting: {{ .Values.greeting | quote }}\n').toString('base64') }],
  values: { greeting: 'default' },
};
await assert.rejects(inspectChart('not-a-chart'), /helm:/);
for (const name of ['first', 'second']) {
  const result = await renderChart({ chartJSON: chart, values: { greeting: name }, release: { name, namespace: 'default', revision: 1, isInstall: true } });
  assert.match(result.manifest, new RegExp(`name: ${name}`));
  assert.match(result.manifest, new RegExp(`greeting: "${name}"`));
  assert.equal(result.metadata.name, 'smoke');
  assert.deepEqual(result.hooks, []);
}
console.log(`Helm WASI smoke passed (${process.versions.bun ? 'Bun' : 'Node'}): invalid chart recovery and repeated isolated rendering`);

if (!process.versions.bun) {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux';
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = process.platform === 'darwin' ? 'Kubus-dev.app/Contents/MacOS' : 'Kubus-dev/bin';
  const bun = path.join(root, 'desktop/build', `dev-${platform}-${process.arch}`, bundle, process.platform === 'win32' ? 'bun.exe' : 'bun');
  execFileSync(bun, [fileURLToPath(import.meta.url)], { stdio: 'inherit' });
}
