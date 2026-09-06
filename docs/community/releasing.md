---
icon: lucide/tag
---

# Releasing

Releases are driven entirely by **git tags**. Pushing a `v*` tag kicks off a workflow that
builds installers on Windows x64, macOS arm64 and Linux x64 runners and attaches them to the GitHub
release for that tag.

## Cut a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

That's it. The release workflow then:

1. Builds installers on each platform's runner.
2. Creates a draft GitHub release for the tag if it doesn't exist yet.
3. Attaches the Electrobun Windows `.zip`, macOS `.dmg`, Linux `.deb` and installer `.tar.gz`, plus full update archives and optional `.patch` files. Uploads update manifests after their payloads, then publishes the release.

!!! tip "Releasing from the GitHub UI"

    Creating a GitHub release with a **new** `v*` tag also pushes that tag, which triggers
    the same workflow. Either path works.

## macOS signatures

The release workflow signs as `Developer ID Application: Florian Schwarz (DJY795VD98)`
and requires Apple notarization. It imports an encrypted certificate into a temporary
macOS keychain and removes the keychain after the job. Missing credentials fail the
release before building; no release is published if macOS verification fails.

Local builds and pull-request CI use ad-hoc signatures. `pnpm --filter @kubus/desktop dist`
defaults `ELECTROBUN_DEVELOPER_ID` to `-`; an explicitly supplied identity takes precedence.
For direct canary builds, set the identity explicitly:

```bash
ELECTROBUN_DEVELOPER_ID=- pnpm --filter @kubus/desktop exec electrobun build --env=canary
```

Electrobun signs the runtime app after writing release metadata, then signs its
self-extracting wrapper before creating the DMG. Signing in `postBuild` is too
early: release metadata still changes afterward. Both bundles need complete
resource seals; leaving only the launcher's linker signature causes macOS to
report `code has no resources but signature indicates they must be present`.

CI and release verification mount the finished DMG, verify its app signature,
compare its embedded payload with the published update archive, then extract
and verify the runtime app. Release verification additionally requires the configured
Apple team, Developer ID Application signatures, stapled notarization tickets on the
DMG and both apps, and Gatekeeper acceptance of both apps. Ad-hoc local/PR builds
do not establish an identified developer or replace Apple notarization.

### One-time Apple account setup

Kubus distributes a DMG through GitHub, outside the Mac App Store. Create a
**Developer ID Application** certificate, using Apple's **G2 Sub-CA** if offered.
A Developer ID Installer certificate is for `.pkg` installers and is not needed here.
The bundle identifier is `io.github.flosch62.kubus`; this app does not currently need
an App Store listing, device registration, or a provisioning profile.

1. Run `node hack/apple-signing.mjs csr` once. It generates a 2048-bit RSA key and
   a verified CSR in `.local/apple-signing/`. The directory is ignored by Git and
   accessible only by its owner; the key is encrypted and its password is stored
   alongside it in an owner-readable file. Keep a secure backup of this folder.
2. Sign in to [Apple Developer Certificates](https://developer.apple.com/account/resources/certificates/list)
   with `schwarz.flori.88@googlemail.com` and select team **Florian Schwarz — DJY795VD98**.
   Click **+**, choose **Developer ID Application**, continue, and upload
   `.local/apple-signing/Kubus.certSigningRequest`. Generate and download the `.cer`.
   Enrollment must be active and any required agreements accepted before certificates
   are available. See [Apple's certificate instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates).
3. Run `node hack/apple-signing.mjs export /path/to/developerID_application.cer`.
   The helper checks the certificate's team, identity, dates, and matching private key,
   then creates an encrypted `.p12` for CI. The public `.cer` alone cannot sign an app.
4. Run `node hack/apple-signing.mjs upload` to set `APPLE_CERTIFICATE_P12_BASE64`
   and `APPLE_CERTIFICATE_PASSWORD` in the `FloSch62/Kubus` repository's Actions secrets.
   Requires an authenticated `gh` CLI with permission to manage repository secrets.
5. At [Apple Account](https://account.apple.com), open **Sign-In and Security →
   App-Specific Passwords** and generate one named `Kubus notarization`.
   Save it as `APPLE_APP_SPECIFIC_PASSWORD` in
   [GitHub Actions repository secrets](https://github.com/FloSch62/Kubus/settings/secrets/actions).
   Use the app-specific password, never your normal Apple login password.
   See [Apple's password instructions](https://support.apple.com/en-us/102654).

Only upload the CSR to Apple's certificate creation form. The private key, password
files, and `.p12` must remain private and must never be attached to a release or committed.
The key and its password share the local directory, so encryption does not protect
against someone who can read that whole directory.

To build a notarized release locally on an Apple Silicon Mac, import the `.p12`
into Keychain Access, then set `KUBUS_NOTARIZE=1`, `ELECTROBUN_DEVELOPER_ID`,
`ELECTROBUN_APPLEID`, `ELECTROBUN_TEAMID`, and `ELECTROBUN_APPLEIDPASS` before running
the normal `dist` command. The workflow contains the public identity values.
[Electrobun's signing guide](https://framework.blackboard.sh/electrobun/guides/code-signing/)
documents the underlying signing and notarization pipeline.

### Check Apple's notarization status without a Mac

Run the Release workflow on the desired branch with `notarization_status_only`
enabled. It uses a macOS runner and the existing password secret to query Apple's
submission history, showing the response in the run summary. Builds and publishing
are skipped, and no new notarization submission is created.

```bash
gh workflow run release.yml --ref feat/electrobun-desktop -f notarization_status_only=true
```

## Desktop updates

Installed Electrobun builds use the native updater with
`https://github.com/FloSch62/Kubus/releases/latest/download` as their release host.
Keep the generated filenames unchanged: `stable-<platform>-<arch>-update.json`
selects the matching full archive. Builds generate a delta patch against the
previous published release when possible; publish `.patch` files too. GitHub's
latest release contains the newest patch, so older installations may need the
full archive when an earlier patch is unavailable. Electrobun handles that fallback.

Kubus checks at startup and every six hours. Users can also check in Settings →
About, download the update, and choose **Restart and install** when ready. Progress
and errors are shared across windows. Restart closes active terminals and port
forwards, flushes preferences, and shuts down the embedded server before the
native updater replaces and relaunches the app.

Development builds disable updating. Debian packages remain managed by `dpkg`;
install a newer `.deb` to update them. Older Kubus versions need one manual install
of a release with this updater before they can update in place.

## Versioning

The `version` in the root and `desktop/package.json` manifests should match the tag you're cutting. Bump it in a
commit before tagging so the in-app version and the release line up.

## See also

<div class="grid cards" markdown>

-   :material-source-branch: **[Building from source](development.md)** for the build commands the workflow runs
-   :material-download: **[Desktop app](../install/desktop.md)** for what users download

</div>
