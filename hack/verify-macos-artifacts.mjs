import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export function verifyMacOSArtifacts(dmg, archive) {
  const notarized = process.env.KUBUS_NOTARIZE === '1';
  const verifyApp = (app) => {
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=4', app], { stdio: 'inherit' });
    if (notarized) {
      assert.ok(process.env.ELECTROBUN_TEAMID, 'Notarized verification requires ELECTROBUN_TEAMID');
      const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${process.env.ELECTROBUN_TEAMID}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
      execFileSync('codesign', ['--verify', '-R', requirement, app], { stdio: 'inherit' });
      execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
      execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', app], { stdio: 'inherit' });
    }
  };
  if (notarized) execFileSync('xcrun', ['stapler', 'validate', dmg], { stdio: 'inherit' });
  const scratch = mkdtempSync(path.join(tmpdir(), 'kubus-signatures-'));
  const mount = path.join(scratch, 'dmg');
  mkdirSync(mount);
  let mounted = false;
  try {
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'inherit' });
    mounted = true;
    const wrapper = path.join(mount, 'Kubus.app');
    verifyApp(wrapper);

    // The first launch replaces the wrapper with this app. Verify the exact
    // embedded payload as well as the independently published update archive.
    const resources = path.join(wrapper, 'Contents', 'Resources');
    const payloads = readdirSync(resources).filter((name) => name.endsWith('.tar.zst'));
    assert.equal(payloads.length, 1, 'Expected one macOS installer payload');
    const payload = readFileSync(path.join(resources, payloads[0]));
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest(payload), digest(readFileSync(archive)), 'DMG payload differs from update archive');

    const tar = path.join(scratch, 'app.tar');
    writeFileSync(tar, zstdDecompressSync(payload));
    const expanded = path.join(scratch, 'expanded');
    mkdirSync(expanded);
    execFileSync('tar', ['-xf', tar, '-C', expanded], { stdio: 'inherit' });
    verifyApp(path.join(expanded, 'Kubus.app'));
    console.log('Verified macOS installer and update app signatures');
  } finally {
    // Do not recursively remove a mount if detach fails.
    if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
    rmSync(scratch, { recursive: true, force: true });
  }
}
