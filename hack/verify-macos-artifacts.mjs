import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const directory = path.resolve('electron/release');
const names = readdirSync(directory);
const artifact = (extension) => {
  const matches = names.filter(name => name.endsWith(extension));
  assert.equal(matches.length, 1, `Expected one ${extension} artifact`);
  assert.match(matches[0], /-mac-arm64\./, 'macOS releases must be Apple Silicon only');
  return path.join(directory, matches[0]);
};
const dmg = artifact('.dmg');
const archive = artifact('.zip');
const scratch = mkdtempSync(path.join(tmpdir(), 'kubus-signatures-'));
const mount = path.join(scratch, 'dmg');
mkdirSync(mount);
const appIn = (directory) => {
  const apps = readdirSync(directory).filter(name => name.endsWith('.app'));
  assert.equal(apps.length, 1, 'Expected one app bundle');
  return path.join(directory, apps[0]);
};
const verifyApp = (app) => {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', app]);
  const requirement = 'anchor apple generic and certificate leaf[subject.OU] = "DJY795VD98" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
  run('codesign', ['--verify', '-R', `=${requirement}`, app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  const executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const architectures = execFileSync('lipo', ['-archs', path.join(app, 'Contents/MacOS', executable)], { encoding: 'utf8' }).trim();
  assert.equal(architectures, 'arm64');
};
let mounted = false;
try {
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
  mounted = true;
  verifyApp(appIn(mount));
  const expanded = path.join(scratch, 'expanded');
  run('ditto', ['-x', '-k', archive, expanded]);
  verifyApp(appIn(expanded));
  console.log('Verified Apple Silicon architecture, Developer ID signatures and notarization in DMG and updater ZIP.');
} finally {
  // Never recursively remove a mount if detach fails.
  if (mounted) run('hdiutil', ['detach', mount]);
  rmSync(scratch, { recursive: true, force: true });
}
