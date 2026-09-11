---
icon: lucide/monitor
---

# Desktop app

The desktop build wraps the Kubus server and UI in a native window. It runs the server
in-process on a random localhost port, opens it for you, and remembers your window size
and position between launches.

## Download

Grab the installer for your platform from the **[releases page](https://github.com/FloSch62/Kubus/releases)**:

| Platform | File |
| --- | --- |
| :material-microsoft-windows: Windows | `kubus-<version>-win-x64.exe` |
| :material-apple: macOS (Apple Silicon) | `kubus-<version>-mac-arm64.dmg` |
| :material-linux: Linux | `kubus-<version>-linux-x86_64.AppImage` or `kubus-<version>-linux-amd64.deb` |

## Install & launch

=== ":material-microsoft-windows: Windows"

    1. Run the `.exe` installer and follow the prompts.
    2. Launch **Kubus** from the Start menu.

    Windows SmartScreen may warn that the publisher is unrecognised (the builds aren't
    code-signed yet). Choose **More info → Run anyway**.

=== ":material-apple: macOS"

    1. Open the `.dmg` and drag **Kubus** into **Applications**.
    2. Open **Kubus** from Applications, Spotlight or the Dock.

    Choose the **`.dmg`** download. The `.zip` on the release page is used by
    in-app updates; you do not need to download or extract it.

    Release builds are signed with Apple Developer ID and notarized. New releases
    require an Apple Silicon Mac (M1 or newer); Intel Macs are no longer supported.

=== ":material-linux: Linux"

    === "AppImage"

        ```bash
        chmod +x kubus-*.AppImage
        ./kubus-*.AppImage
        ```

    === "Debian / Ubuntu (.deb)"

        ```bash
        sudo apt install ./kubus-*-linux-amd64.deb
        kubus
        ```

## Updating

The macOS app, Windows installer and Linux AppImage check GitHub Releases shortly
after startup and every four hours. A notification offers **Download update** or
**Later**. Kubus downloads the update only when you request it. Once downloaded,
choose **Restart to update** and confirm to install it. **Quitting normally does
not install updates**, even after downloading one. You can check, download, follow
progress, or retry in **Settings → About**. After reopening Kubus, a requested
download can reuse the verified cached update.

Save edits before restarting. All Kubus windows close and terminals, log streams
and port forwards disconnect. Settings are preserved. On macOS, run the installed
copy from Applications rather than directly from the disk image.

Debian packages use your package manager or a newer `.deb` from Releases. A future
Microsoft Store build uses Store-managed updates. Browser installs show a download
link. Updating from older desktop versions requires installing the new release once
manually, since they did not contain an auto-updater.

Update requests go to GitHub and its download CDN and include the installed version
and platform as required by the updater. They do not include kubeconfigs or cluster
data. There is no telemetry. See [Releasing](../community/releasing.md) for signing
and Windows distribution options.

## Next steps

<div class="grid cards" markdown>

-   :material-rocket-launch: **Quickstart**

    ---

    Connect your first cluster and take the tour.

    [:octicons-arrow-right-24: Quickstart](../quickstart.md)

</div>
