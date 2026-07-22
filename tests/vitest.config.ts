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
        resolve: {
          alias: [
            ...sharedSrcAlias,
            {
              find: '@kubus/server',
              replacement: path.join(repoRoot, 'server/src/server.ts'),
            },
            {
              find: 'fix-path',
              replacement: path.join(repoRoot, 'electron/node_modules/fix-path/index.js'),
            },
          ],
        },
        test: {
          name: 'electron',
          environment: 'node',
          include: ['tests/unit/electron/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: [
            ...sharedSrcAlias,
            {
              find: 'elkjs/lib/elk-api.js',
              replacement: path.join(repoRoot, 'tests/setup/mock-elk.ts'),
            },
            {
              find: '@tanstack/react-query',
              replacement: path.join(repoRoot, 'tests/setup/mock-react-query.tsx'),
            },
            {
              find: '@monaco-editor/react',
              replacement: path.join(repoRoot, 'tests/setup/mock-monaco.tsx'),
            },
            {
              find: 'react-router',
              replacement: path.join(repoRoot, 'client/node_modules/react-router/dist/development/index.js'),
            },
          ],
        },
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
      // Keep every repository-wide metric at or above 50%. Package floors
      // also prevent strong shared coverage from hiding a large client or
      // server regression while those packages continue to improve.
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50,
        'client/src/**': { statements: 11, branches: 9, functions: 7, lines: 11 },
        'electron/src/**': { statements: 80, branches: 60, functions: 85, lines: 85 },
        'server/src/**': { statements: 14, branches: 15, functions: 14, lines: 14 },
        'shared/src/**': { statements: 95, branches: 90, functions: 90, lines: 95 },
      },
    },
  },
});
