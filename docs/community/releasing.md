---
icon: lucide/tag
---

# Releasing

Releases are driven entirely by **git tags**. Pushing a `v*` tag kicks off a workflow that
builds installers on Windows, macOS and Linux runners and attaches them to the GitHub
release for that tag.

## Cut a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

That's it. The release workflow then:

1. Builds installers on each platform's runner.
2. Creates the GitHub release for the tag if it doesn't exist yet.
3. Attaches the `.exe`, `.dmg`, `.AppImage` and `.deb` artifacts to it.
4. Saves the unsigned Windows `.appx` in the separate **kubus-windows-store** Actions artifact for submission to Microsoft Store.
5. Triggers a docs deploy, which republishes `latest.json` on GitHub Pages from the latest release. This powers the in-app update check for non-Store installations.
6. Submits stable releases to Microsoft Store after the GitHub release job succeeds, using the configured repository secrets. The first Store release must already be live; pending submissions are left intact.

Microsoft Store certification runs after submission and may finish later than the
GitHub release. See [Publishing to Microsoft Store](microsoft-store.md) for initial
publication, CI credentials, Windows testing and retry instructions.

!!! tip "Releasing from the GitHub UI"

    Creating a GitHub release with a **new** `v*` tag also pushes that tag, which triggers
    the same workflow. Either path works.

## Versioning

The `version` in both the root and `electron/package.json` must match the tag you're
cutting. Bump them in a commit before tagging so the in-app version and the release line
up. Tag a commit whose CI checks have passed; the Release workflow verifies versions
and builds packages but does not rerun the full test suite.

## See also

<div class="grid cards" markdown>

-   :material-source-branch: **[Building from source](development.md)** for the build commands the workflow runs
-   :material-download: **[Desktop app](../install/desktop.md)** for what users download

</div>
