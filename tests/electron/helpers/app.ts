import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(testsDir, '..');
const electronRoot = path.join(repoRoot, 'electron');

interface LaunchOptions {
  deepLink?: string;
  stateDir?: string;
}

export interface LaunchedElectron {
  app: ElectronApplication;
  page: Page;
  stateDir: string;
  userDataDir: string;
  close(): Promise<void>;
}

export async function launchElectron(options: LaunchOptions = {}): Promise<LaunchedElectron> {
  for (const artifact of ['electron/dist/main.js', 'electron/dist/preload.js', 'client/dist/index.html']) {
    if (!existsSync(path.join(repoRoot, artifact))) {
      throw new Error(`electron e2e: ${artifact} missing — run \`pnpm build\` first.`);
    }
  }

  const stateDir = options.stateDir ?? mkdtempSync(path.join(tmpdir(), 'kubus-electron-e2e-'));
  const configHome = path.join(stateDir, 'config');
  const userDataDir = path.join(stateDir, 'user-data');
  const kubeconfig = path.join(stateDir, 'kubeconfig');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    kubeconfig,
    `${JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [],
      contexts: [],
      users: [],
      'current-context': '',
    })}\n`,
    { mode: 0o600 },
  );

  const platformArgs =
    process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu'] : [];
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      cwd: electronRoot,
      args: [
        '.',
        ...(options.deepLink ? [options.deepLink] : []),
        ...platformArgs,
        `--user-data-dir=${userDataDir}`,
      ],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        KUBECONFIG: kubeconfig,
        KUBUS_NO_OPEN: '1',
      },
      timeout: 20_000,
    });
    const page = await app.firstWindow();
    let closed = false;
    return {
      app,
      page,
      stateDir,
      userDataDir,
      async close() {
        if (closed) return;
        closed = true;
        try {
          if (app && app.process().exitCode === null) await app.close();
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
}
