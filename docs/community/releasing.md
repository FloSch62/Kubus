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
4. Triggers a docs deploy, which republishes `latest.json` on GitHub Pages from the latest release. This powers the in-app update check.

!!! tip "Releasing from the GitHub UI"

    Creating a GitHub release with a **new** `v*` tag also pushes that tag — which triggers
    the same workflow. Either path works.

## Versioning

The `version` in the root `package.json` should match the tag you're cutting. Bump it in a
commit before tagging so the in-app version and the release line up.

## See also

<div class="grid cards" markdown>

-   :material-source-branch: **[Building from source](development.md)** — the build commands the workflow runs
-   :material-download: **[Desktop app](../install/desktop.md)** — what users download

</div>
