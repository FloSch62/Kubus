import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Set the identity before starting Hutch: config evaluation runs in a separate
// process, so setting process.env inside electrobun.config.ts would not reach it.
const env = { ...process.env };
if (process.platform === 'darwin') {
  if (env.KUBUS_NOTARIZE === '1') {
    for (const name of ['ELECTROBUN_DEVELOPER_ID', 'ELECTROBUN_APPLEID', 'ELECTROBUN_APPLEIDPASS', 'ELECTROBUN_TEAMID']) {
      if (!env[name]?.trim()) throw new Error(`Notarized releases require ${name}`);
    }
    if (env.ELECTROBUN_DEVELOPER_ID === '-' || env.ELECTROBUN_SKIP_NOTARIZATION) {
      throw new Error('Notarized releases require a Developer ID identity and cannot skip notarization');
    }
  } else {
    env.ELECTROBUN_DEVELOPER_ID ||= '-';
  }
}
const cli = fileURLToPath(new URL('bin/electrobun.cjs', import.meta.resolve('electrobun/package.json')));
const result = spawnSync(process.execPath, [cli, 'build', '--env=stable'], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
