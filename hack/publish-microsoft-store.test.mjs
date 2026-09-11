import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publishStore } from './publish-microsoft-store.mjs';

async function fixture(t, overrides = {}, packageVersion = '1.9.0.0') {
  const directory = await mkdtemp(path.join(tmpdir(), 'kubus-store-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'kubus-0.9.1-win-x64.appx'), 'built-package');
  const app = {
    Id: '9PCTHB079SK7',
    PackageIdentityName: 'FloSch.me.Kubus',
    LastPublishedApplicationSubmission: { Id: 'published' },
    PendingApplicationSubmission: null,
    ...overrides,
  };
  const submission = { Id: 'published', ApplicationPackages: [{ Version: packageVersion }] };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'apps') return JSON.stringify(app);
    if (args[1] === 'get') return JSON.stringify(submission);
    return '';
  };
  return { directory, app, submission, calls, run };
}

await test('keeps the first manual submission intact', async (t) => {
  const f = await fixture(t, { LastPublishedApplicationSubmission: null, PendingApplicationSubmission: { Id: 'first-draft' } });
  assert.match(await publishStore(f.directory, '0.9.1', f.run), /first release manually/);
  assert.deepEqual(f.calls, [['apps', 'get', '9PCTHB079SK7']]);
});

await test('does not overwrite a draft or a submission awaiting certification', async (t) => {
  const f = await fixture(t, { PendingApplicationSubmission: { Id: 'pending' } });
  await assert.rejects(publishStore(f.directory, '0.9.1', f.run), /pending Store submission/);
  assert.equal(f.calls.length, 1);
});

await test('refuses to publish into an unexpected product', async (t) => {
  const f = await fixture(t, { PackageIdentityName: 'Another.App' });
  await assert.rejects(publishStore(f.directory, '0.9.1', f.run), /unexpected product identity/);
  assert.equal(f.calls.length, 1);
});

await test('does not publish when the submission changes during the check', async (t) => {
  const f = await fixture(t);
  f.submission.Id = 'new-draft';
  await assert.rejects(publishStore(f.directory, '0.9.1', f.run), /submission changed/);
  assert.equal(f.calls.length, 2);
});

for (const version of ['1.9.1.0', '1.10.0.0', '2.0.0.0']) {
  await test(`skips a duplicate or older release when ${version} is already published`, async (t) => {
    const f = await fixture(t, {}, version);
    assert.match(await publishStore(f.directory, '0.9.1', f.run), /already published/);
    assert.equal(f.calls.length, 2);
  });
}

await test('uploads the built AppX then commits, without adding workspace dependencies', async (t) => {
  const f = await fixture(t);
  assert.match(await publishStore(f.directory, '0.9.1', f.run), /Submitted Kubus 0.9.1/);
  assert.deepEqual(f.calls.slice(2), [
    ['publish', f.directory, '--inputDirectory', f.directory, '--appId', '9PCTHB079SK7', '--noCommit', '--uploadTimeout', '600'],
    ['submission', 'publish', '9PCTHB079SK7'],
  ]);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'package.json'), 'utf8')), {
    name: 'kubus-store-submission', private: true, version: '0.9.1',
  });
  assert.equal(await readFile(path.join(f.directory, 'kubus-0.9.1-win-x64.appx'), 'utf8'), 'built-package');
});

await test('never commits if the upload fails', async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishStore(f.directory, '0.9.1', (args) => {
    if (args[0] === 'publish') throw new Error('Upload failed');
    return f.run(args);
  }), /Upload failed/);
  assert.equal(f.calls.length, 2);
});

await test('rejects ambiguous and mismatched package artifacts before contacting the Store', async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishStore(f.directory, '0.9.2', f.run), /Expected exactly one/);
  await writeFile(path.join(f.directory, 'extra.appx'), 'unexpected');
  await assert.rejects(publishStore(f.directory, '0.9.1', f.run), /Expected exactly one/);
  assert.equal(f.calls.length, 0);
});

await test('refuses prereleases and malformed published versions', async (t) => {
  const f = await fixture(t, {}, 'invalid');
  await assert.rejects(publishStore(f.directory, '0.9.1-beta.1', f.run), /Only stable/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(publishStore(f.directory, '0.9.1', f.run), /invalid package version/);
  assert.equal(f.calls.length, 2);
});
