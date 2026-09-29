import { Arch, build, Platform } from 'electron-builder';
import { distributionConfig } from './build-config.ts';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [flag, target] = process.argv.slice(2);
const platform = flag === '--mac' ? Platform.MAC : flag === '--win' ? Platform.WINDOWS : flag === '--linux' ? Platform.LINUX : undefined;
if (flag && !platform) throw new Error(`Unknown platform: ${flag}`);
if (target === 'appx' || process.env.KUBUS_WINDOWS_TARGET === 'store') {
  if (process.platform !== 'win32') throw new Error('Store packaging requires Windows with Visual Studio C++ Build Tools.');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./build-store-updater.ps1', import.meta.url))], { stdio: 'inherit' });
}
await build({
  config: distributionConfig(target === 'appx' ? { ...process.env, KUBUS_WINDOWS_TARGET: 'store' } : process.env, platform?.nodeName ?? process.platform),
  targets: platform?.createTarget(target, platform === Platform.MAC ? Arch.arm64 : Arch.x64),
  publish: 'never',
});
