---
icon: lucide/store
---

# Publishing to Microsoft Store

Kubus's Windows build produces an NSIS installer for GitHub downloads and an unsigned
AppX package for the Microsoft Store. AppX is accepted through Partner Center's
**MSIX or PWA app** submission route. Microsoft signs the package after certification;
no purchased code-signing certificate is needed for this submission.

## Product identity

These values belong to the reserved Kubus product and must remain stable across updates:

| Partner Center field | Value |
| --- | --- |
| Package/Identity/Name | `FloSch.me.Kubus` |
| Package/Identity/Publisher | `CN=7F1CC962-95FE-4843-B655-1EC6FF3D190E` |
| Package/Properties/PublisherDisplayName | `FloSch.me` |
| Package family name | `FloSch.me.Kubus_mk0vma40c9qne` |
| Store ID | `9PCTHB079SK7` |

The package settings are in `electron/electron-builder.yml`. The application ID is
`Kubus`, the architecture is x64, and the minimum Windows version is 10.0.19041.0.
The existing `kubus://` protocol is included in the generated package manifest.
Store tile assets are rendered from the Kubus SVG during the Electron build.

## Obtain the submission package

After pushing the changes, open the successful **CI** run in GitHub Actions and download
the **kubus-windows-store** artifact. Extract its ZIP to get
`kubus-<version>-win-x64.appx`.

The **Release** workflow also produces this separate artifact. To build without
publishing a GitHub release, run that workflow manually on the desired branch and leave
**publish_tag** empty. The unsigned `.appx` is kept out of public GitHub release assets.

To build locally, use a **Windows** machine with the project's Node.js, pnpm and Go
versions installed:

```powershell
pnpm install --frozen-lockfile
pnpm dist:store
```

The output is in `electron/release/`. The installed electron-builder version requires
Windows to create AppX packages; Linux can build the application but not this package.
The Store requires a nonzero major version and a zero fourth component. The
`appx-manifest.cjs` hook maps the application version to
`<major + 1>.<minor>.<patch>.0`: app version `0.9.0` produces package version `1.9.0.0`,
and app version `1.0.0` will produce `2.0.0.0`. The app's own version and other platform
versions are unchanged. Keep this mapping for future releases so installed packages can
upgrade in order. See Microsoft's
[package version rules](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements#package-version-numbering).
Bump the application version before submitting a changed package as an update.

## Test on Windows

An unsigned submission package is not a public sideload installer. For a local install,
sign a **copy** with a development certificate matching the package publisher and trust
that certificate on the test machine. Keep the unsigned original for Partner Center.
See Microsoft's [package signing guide](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview).

Exercise the installed package before public release:

1. Launch from Start, including on a profile with no kubeconfig.
2. Read and edit a test kubeconfig, including a custom `KUBECONFIG` location.
3. Connect using any installed authentication helpers you support, such as `aws`,
   `gke-gcloud-auth-plugin` and `kubelogin`.
4. View logs, open a shell, forward a port, and render/install a Helm chart on a test cluster.
5. Open a `kubus://` resource link with the app closed and with it already running.
6. In **Settings → About**, choose **Check for updates**. It should open Kubus's Store
   page. Background checks must not open the Store or advertise GitHub installers.
7. Verify settings survive an update to a newer Store package.

## Submit in Partner Center

1. Open the reserved Kubus product and choose **Start submission**.
2. In **Pricing and availability**, choose **Free**, the intended markets and visibility.
3. Complete **Properties** and **Age ratings**. Provide a support URL and a privacy
   policy accurately describing local credential storage and network connections.
4. Upload the extracted `.appx` under **Packages**, not the Actions ZIP or NSIS `.exe`.
5. Add the Store description, screenshots and required listing artwork.
6. Explain the `runFullTrust` capability under **Submission options** and provide testing
   instructions, including how to connect a test Kubernetes cluster.
7. Choose the publishing schedule and submit for certification.

Suggested capability explanation:

> Kubus is an Electron desktop Kubernetes client. It reads and writes user-provided
> kubeconfig files, connects to Kubernetes API servers selected by the user, runs
> configured authentication helpers, and hosts its interface on a local loopback server.
> It needs full-trust desktop execution for these functions and does not require
> administrator privileges.

The listing is only available after approval and publication. See the official
[submission checklist](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission).

## Installation and updates

Once the listing is live, point the website's Windows download button to
<https://apps.microsoft.com/detail/9PCTHB079SK7>. Users can install through the Store app
or Microsoft's web installer. To install from the website without opening the Store app,
generate a [Store badge](https://apps.microsoft.com/badge) with **Launch mode: Direct**.
Do not replace the current download link before the listing is published.

The Store handles signing, installation and updates for Store installations. Once the
first release is live, the **Release** workflow submits subsequent stable releases to
the same product automatically when the credentials below are configured. Microsoft
still certifies each update before publishing it according to the submission's schedule.

Kubus detects packaged Store installations at runtime. Its background update check skips
the GitHub manifest, and the explicit **Check for updates** action opens the Store. This
avoids offering a GitHub release before that version is available in the Store.
The separate GitHub `.exe` remains unsigned and can still show SmartScreen warnings.

Existing NSIS installations do not automatically turn into Store installations. Test
settings migration before advising existing users to switch installation methods.

## Automated release submissions

Complete the first Store submission manually using the artifact above. Then configure
an application registration in a Microsoft Entra tenant linked to the existing Store
developer account. Add that application in **Partner Center → Account settings → User
management → Microsoft Entra applications**, with the **Manager** role for the Windows
developer program.

In the GitHub repository's **Settings → Secrets and variables → Actions**, add:

| Repository secret | Value |
| --- | --- |
| `AZURE_AD_TENANT_ID` | Directory (tenant) ID of the linked tenant |
| `AZURE_AD_APPLICATION_CLIENT_ID` | Application (client) ID of the application registration |
| `AZURE_AD_APPLICATION_SECRET` | Client secret **Value**, not its Secret ID |
| `SELLER_ID` | Seller ID of the existing Store publisher account that owns Kubus |

The Seller ID is in Partner Center's **Account settings → Legal info / Legal profile →
Developer → Publisher IDs**. It belongs to the publisher account, regardless of which
authorized login accesses it. It is different from Kubus's Store product ID. Store the
client secret directly in GitHub and replace it before its chosen expiration date.
See Microsoft's [GitHub Actions publishing guide](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/github-actions).

For stable tags, the workflow downloads the Windows artifact after the GitHub release
job succeeds, configures Microsoft Store Developer CLI v0.4.2, and checks the existing
Store product:

- Before the first published submission, it leaves the manual submission intact and
  records instructions in the job summary. No additional switch is needed after that
  first release is live.
- A pending draft or submission in certification stops the job before any upload.
  Finish the pending submission in Partner Center, then rerun the **publish-store** job.
- A package version already published, or newer, is skipped. This makes reruns safe
  after certification and prevents an older release replacing a newer one.
- Otherwise, it uploads the new package and commits the submission for certification.
  It reuses the last published listing and publishing schedule. The job finishes after
  submission; success does not mean certification or Store publication has completed.

Store jobs are serialized. Avoid editing a submission in Partner Center while the
workflow is uploading it. If an upload or commit fails, inspect the resulting draft
before retrying; the workflow will not delete a pending submission to retry it.

The CLI's Electron publisher supports `.appx` files but runs `npm install` when detecting
a project. `hack/publish-microsoft-store.mjs` therefore stages a minimal package manifest
next to the downloaded artifact, without dependencies or scripts. It publishes the
existing AppX without rebuilding or installing the repository's workspace packages.

Pull requests, pushes to `main`, prerelease tags, and manual builds with an empty
**publish_tag** do not submit to the Store. When manually publishing an existing tag,
the workflow checks out that tag for both the build and the Store upload.
