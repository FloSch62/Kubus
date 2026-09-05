import { build } from 'esbuild';

// Resolve networking packages with Node semantics before Hutch's Bun bundler.
// Bun treats node-fetch, undici, and ws as built-ins even with alias overrides;
// those substitutes discard Kubernetes TLS identities and proxy agents.
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  external: ['electrobun/main', 'bufferutil', 'utf-8-validate'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
