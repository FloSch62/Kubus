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
  test: {
    projects: [
      {
        resolve: { alias: sharedSrcAlias },
        test: {
          name: 'shared',
          environment: 'node',
          include: ['unit/shared/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: sharedSrcAlias },
        test: {
          name: 'server',
          environment: 'node',
          include: ['unit/server/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: sharedSrcAlias },
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['unit/client/**/*.test.{ts,tsx}'],
          setupFiles: ['setup/client.ts'],
          // Testing Library's auto-cleanup hooks into the global afterEach.
          globals: true,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      // The code under test lives in the sibling packages, outside this
      // package's root.
      allowExternal: true,
      include: ['**/shared/src/**', '**/server/src/**', '**/client/src/**'],
    },
  },
});
