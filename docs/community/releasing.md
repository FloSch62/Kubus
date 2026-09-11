---
icon: lucide/tag
---

# Releasing

Kubus uses Electron and `electron-updater`. Pushing a `v*` tag builds Windows x64
installers, macOS Apple Silicon DMG installers, and Linux x64 AppImage + Debian packages.
Mac users download the DMG and drag Kubus into Applications. The release also contains
a ZIP used internally by the updater; users do not need to download or extract it.
Intel macOS and universal builds are no longer produced.

## Cut a release

Bump both the root and `electron/package.json` versions in a commit, then tag it:

```bash
git tag v0.10.0
git push origin v0.10.0
```

The workflow verifies versions, builds all platforms, checks signatures, and uploads
installers, ZIPs, differential `.blockmap` files and `latest*.yml` update feeds. New
releases stay in draft until all assets are uploaded. Payloads are uploaded before
feeds, including when using the manual `publish_tag` input to repair a release.
Prefer a new version for an update: clients can cache the old payload for a reused version.

Keep `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, the macOS ZIP and blockmaps
on the release. They are required for in-app updates. Do not sign or otherwise modify
an installer after its hashes/blockmaps have been generated. Windows signing hooks
run inside the packaging step, before update metadata is generated.

The docs deployment continues publishing `latest.json` for browser installs and old
Electron versions that only offer a download link. Users of those versions must
install an updater-enabled release once manually. In particular, old unsigned Mac
apps cannot be upgraded into the signed release through Squirrel.Mac.

## Apple signing and notarization

Release builds use **Developer ID Application: Florian Schwarz (DJY795VD98)** and
Apple team `DJY795VD98`. The existing secrets from PR #169 are reused:

| Repository secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | Base64-encoded encrypted Developer ID Application P12 |
| `APPLE_CERTIFICATE_PASSWORD` | P12 password |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for `schwarz.flori.88@googlemail.com` |

`electron-builder` imports the P12 into a temporary keychain, signs the app and
nested Electron binaries with hardened runtime, notarizes the app and staples the
ticket before producing the DMG and updater ZIP. It disposes the temporary signing
keychain after packaging. Both distributed app bundles are independently extracted
and checked with `codesign`, the expected Apple team requirement, `stapler`, `spctl`
and `lipo`. A missing credential, failed notarization or wrong architecture fails
the release; there is no unsigned fallback for macOS releases.

The Release workflow's **notarization_status_only** input queries Apple submission
history without building or publishing. First notarization can take longer than
subsequent submissions; use this to inspect pending submissions.

`node hack/apple-signing.mjs csr`, `export <certificate.cer>` and `upload` retain the
signing helper from PR #169. It uses `.local/apple-signing/`, which is gitignored;
private keys, passwords and certificates must stay there. Reuse the existing key
and CSR; do not generate replacements just to build this branch.

Local `pnpm dist` builds stay unsigned unless explicitly configured for release.
On a Mac, `KUBUS_RELEASE=1` requires the standard builder variables `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_SPECIFIC_PASSWORD`.
Provide these securely through the environment, not command-line literals.

## Windows distribution choices

The default remains **unsigned NSIS** with working in-app downloads and updates.
Windows can display unknown-publisher/SmartScreen prompts. HTTPS and SHA-512 update
hashes protect transport/integrity; they do not provide an Authenticode publisher
identity. Once signing is enabled, updater metadata pins the configured publisher
and release verification checks both the app executable and installer.

Research checked 6 September 2026:

| Route | Cost / requirements | Updating |
| --- | --- | --- |
| [SignPath Foundation](https://signpath.org/terms) | Free for approved open-source projects; application, project reputation, signing policy and release approval requirements | Signed NSIS with `electron-updater` |
| [Microsoft Store](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/) | Free individual registration; identity verification and app certification | Store signs the AppX/MSIX and manages updates |
| [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku) | Basic is $9.99/month; public-trust individual accounts currently limited to US/Canada | Signed NSIS with `electron-updater` |
| Commercial certificate or organization-managed signing | Depends on CA/provider and hardware/cloud key storage | Signed NSIS with `electron-updater` |
| Enterprise MSIX/AppX sideloading | An organization can deploy its own trusted certificate | Organization / App Installer manages updates |

For a German individual developer, start with SignPath if direct downloads and the
same in-app update experience are the priority. The Store is the other free route.
Azure supports EU organizations, but [individual eligibility currently excludes
Germany](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart).
Acceptance by SignPath or the Store has not been obtained by this change.

MSIX alone does not remove signing requirements. Outside the Store, the certificate
must be trusted on the target device. A self-signed certificate is useful for managed
enterprise deployments and local tests, rather than frictionless public downloads.
[Microsoft's signing comparison](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
also distinguishes Store AppX/MSIX submissions from Store EXE/MSI listings, whose
installers still need publisher signing.

### Configure signed NSIS

Set repository variable `WINDOWS_SIGNING` to one of the following. `unsigned` is the
explicit default. Every signed mode requires `WINDOWS_PUBLISHER_NAME` to exactly
match the certificate's common name. Misconfigured signed modes fail the build.

| Mode | Additional configuration |
| --- | --- |
| `certificate` | Secrets `WINDOWS_CERTIFICATE_P12_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`; locally use `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`. Alternatively `WINDOWS_CERTIFICATE_SHA1` selects an installed certificate on a prepared Windows runner. |
| `azure` | Variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`; secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` for the signing principal. |
| `custom` | Variable `WINDOWS_SIGN_SCRIPT` pointing to a checked-in electron-builder signing hook. Configure that provider's authentication in the workflow after onboarding. |

The custom hook must sign **each file it receives** in place and await completion.
It covers the application, NSIS uninstaller and installer before hashes are generated.
SignPath's approved artifact/provenance workflow must be integrated after acceptance;
a generic post-build signing action on the final EXE would invalidate updater hashes
and leave the application unsigned. The custom mode is an integration point, not a
claim that a SignPath account or signing pipeline already exists.

When switching certificates/publishers, ship a bridge release trusted by the old
publisher and allowing the new one before rotating. Never disable updater signature
verification just to bypass a publisher mismatch. The initial unsigned-to-signed
transition should be tested separately with the installed unsigned version.

### Prepare a Microsoft Store submission

The pinned electron-builder 26 supports **AppX**. Microsoft Store accepts this format
alongside MSIX; a builder upgrade can add native MSIX output later. Reserve Kubus in
Partner Center and copy its exact identity values into repository variables:

- `WINDOWS_STORE_IDENTITY_NAME`
- `WINDOWS_STORE_PUBLISHER` (the full `CN=…` value)
- `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`

Run the **Windows Store package** workflow on this branch. It produces an unsigned
Store submission in the `kubus-windows-store` workflow artifact. Submit it in Partner
Center; Microsoft signs it after certification. It is not a public sideload installer.
The packaged app carries `kubusUpdateMode: store`, so GitHub updates stay disabled
regardless of the runtime's Store detection. NSIS release assets remain separate.
The app requests the full-trust capability required by Electron; certification and
kubeconfig/credential-plugin access still need testing on Windows.

For enterprise sideloading, use the same reserved organization identity, sign the
package using a certificate trusted by managed devices, and publish an App Installer
feed or deploy through device management. Keep the managed-update marker. This is
an organization-specific deployment step, not a preconfigured public MSIX feed.

## Update validation before the first release

Unit tests cover explicit download/install consent, progress, errors, concurrent windows, macOS handoff,
installation and stalled shutdown. Electron end-to-end tests exercise the actual
shell. The Linux release job also runs a real packaged updater integration test.
Run it locally on Linux after building:

```bash
pnpm build
pnpm build:helm-engine
xvfb-run --auto-servernum pnpm test:updater
```

This builds two temporary AppImages with a localhost feed. It checks that update
notifications and dismissal download nothing, rejects an incorrect SHA-512
checksum after an explicit download, and retries only on request. It verifies
that cancelling restart, quitting normally, and reopening keep the old version
even after a successful download. Finally it confirms **Restart to update**, checks
automatic relaunch into the new version, and verifies retained desktop state.
It uses an empty kubeconfig and isolated app/config/cache directories, then removes
the test files. It does not publish a release or change the repository version.
The test requires a display (or Xvfb) and exercises full downloads.

Both `autoDownload` and `autoInstallOnAppQuit` are disabled. On macOS, the downloaded
ZIP is not handed to Squirrel for signature validation/staging until the user
confirms installation. Earlier staging could schedule installation on quit.

These checks do not replace a signed update test on macOS and Windows:

1. Install the signed/current build in a disposable user profile.
2. Publish a higher test version to a dedicated test feed with its generated metadata.
3. Confirm that checks only notify, then explicitly download. Check progress,
   disconnect/retry, and reject a modified payload.
4. Open multiple windows and a port forward, then restart to update. Verify shutdown,
   the new version, retained preferences and the signature. Also verify that normal
   quit after a download leaves the installed version unchanged.
5. On macOS, install from the DMG into Applications and verify Gatekeeper and the
   Squirrel signature check. On Windows, test both per-user and elevated installations.

Use a test feed on the test build; do not repoint production clients or publish test
versions into the stable feed. Actual Apple/Windows signed upgrade validation requires
those operating systems and two release versions.
