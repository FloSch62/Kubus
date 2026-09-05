import { build } from 'esbuild';

// Bundle the main process plus the whole server into one ESM file so the
// packaged app needs no node_modules (pnpm symlinks never reach the asar).
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // bufferutil/utf-8-validate are optional ws natives we don't install.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    // CJS deps converted into the ESM bundle still call require() at runtime.
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

// The preload runs in the sandboxed renderer, which only supports CJS.
await build({
  entryPoints: ['src/preload.ts'],
  bundle: true,
  outfile: 'dist/preload.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
});
