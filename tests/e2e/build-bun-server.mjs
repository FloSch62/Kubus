import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// Match desktop's dependency resolution: retain real TLS/proxy transports,
// while the fixture helper keeps its own import.meta.url and isolated state.
await build({
  entryPoints: [path.join(dir, 'start-server.mjs')],
  outfile: path.join(dir, '.state/start-server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  external: [path.join(dir, 'helpers/cluster.mjs'), 'bufferutil', 'utf-8-validate'],
});
