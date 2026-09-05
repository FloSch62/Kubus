import { readFileSync } from 'node:fs';

const refName = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;

if (!refName || !refName.startsWith('v')) {
  console.log('No release tag detected; skipping version check.');
  process.exit(0);
}

const expectedVersion = refName.slice(1);
const manifests = ['package.json', 'desktop/package.json'];
const mismatches = [];

for (const manifestPath of manifests) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (manifest.version !== expectedVersion) {
    mismatches.push(
      `${manifestPath} has version ${manifest.version}, expected ${expectedVersion}`,
    );
  }
}

if (mismatches.length > 0) {
  console.error(`Release tag ${refName} does not match package metadata:`);
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log(`Release tag ${refName} matches package version ${expectedVersion}.`);
