import { Arch, build, Platform } from 'electron-builder';
import { distributionConfig } from './build-config.ts';

const [flag, target] = process.argv.slice(2);
const platform = flag === '--mac' ? Platform.MAC : flag === '--win' ? Platform.WINDOWS : flag === '--linux' ? Platform.LINUX : undefined;
if (flag && !platform) throw new Error(`Unknown platform: ${flag}`);
await build({
  config: distributionConfig(target === 'appx' ? { ...process.env, KUBUS_WINDOWS_TARGET: 'store' } : process.env, platform?.nodeName ?? process.platform),
  targets: platform?.createTarget(target, platform === Platform.MAC ? Arch.arm64 : Arch.x64),
  publish: 'never',
});
