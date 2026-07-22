import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..');

// Unit tests import package sources directly (no build step needed), so
// @kubus/shared must resolve to shared/src instead of the built dist the
// package.json exports point at. Order matters: the subpath entry must be
// tried before the bare package name prefix-matches it.
const sharedSrcAlias = [
  {
    find: '@kubus/shared/ws-protocol',
    replacement: path.join(repoRoot, 'shared/src/ws-protocol.ts'),
  },
  { find: '@kubus/shared', replacement: path.join(repoRoot, 'shared/src/index.ts') },
];

export default defineConfig({
  // Keep the repository as the Vitest root. Coverage discovers untested files
  // relative to this value; when the root was tests/, sibling package sources
  // were only reported if a test happened to import them.
  root: repoRoot,
  test: {
    projects: [
      {
        resolve: { alias: sharedSrcAlias },
        test: {
          name: 'shared',
          environment: 'node',
          include: ['tests/unit/shared/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: sharedSrcAlias },
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/unit/server/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: sharedSrcAlias },
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['tests/unit/client/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/setup/client.ts'],
          // Testing Library's auto-cleanup hooks into the global afterEach.
          globals: true,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'tests/coverage',
      include: [
        'shared/src/**/*.ts',
        'server/src/**/*.ts',
        'client/src/**/*.{ts,tsx}',
        'electron/src/**/*.ts',
      ],
      exclude: ['**/*.d.ts'],
      // Start with honest, achievable non-regression floors and ratchet them
      // upward as high-risk areas gain tests. Package floors prevent strong
      // shared coverage from hiding a client or server regression.
      thresholds: {
        statements: 13,
        branches: 12,
        functions: 9,
        lines: 13,
        'client/src/**': { statements: 11, branches: 9, functions: 7, lines: 11 },
        'server/src/**': { statements: 14, branches: 15, functions: 14, lines: 14 },
        'shared/src/**': { statements: 95, branches: 90, functions: 90, lines: 95 },
      },
    },
  },
});
