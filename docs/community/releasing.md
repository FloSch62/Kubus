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

`pnpm --filter @kubus/desktop dist` enables Electrobun's signing pipeline and
defaults `ELECTROBUN_DEVELOPER_ID` to `-` on macOS (ad-hoc signing, no Apple
certificate required). An explicitly supplied identity takes precedence.
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
and verify the runtime app. Ad-hoc signatures provide integrity checks but do
not establish an identified developer or replace Apple notarization. Browser
downloads can still require explicit approval in macOS.

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
