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
| :material-microsoft-windows: Windows x64 | `win-x64-Kubus-Setup.zip` |
| :material-apple: macOS (Apple Silicon only) | `macos-arm64-Kubus.dmg` |
| :material-linux: Debian / Ubuntu x64 | `kubus-<version>-linux-x64.deb` |
| :material-linux: Other Linux x64 | `linux-x64-Kubus-Setup.tar.gz` |

## Install & launch

=== ":material-microsoft-windows: Windows"

    1. Extract the `.zip` archive, then run its `.exe` installer. Keep the accompanying payload beside the executable.
    2. Launch **Kubus** from the Start menu.

    Windows SmartScreen may warn that the publisher is unrecognised (the builds aren't
    code-signed yet). Choose **More info → Run anyway**.

=== ":material-apple: macOS"

    1. Open the `.dmg` and drag **Kubus** into **Applications**.
    2. The builds aren't notarised yet, so the first launch needs one extra step:

        - Open **System Settings → Privacy & Security**, choose **Open Anyway**
          if offered after the failed launch, then confirm, *or*
        - for a download you trust, clear its quarantine flag from a terminal:

        ```bash
        xattr -r -d com.apple.quarantine /Applications/Kubus.app
        ```

    After the first launch you can open it normally from Spotlight or the Dock.

=== ":material-linux: Linux"

    On Debian or Ubuntu, install the `.deb` with its dependencies:

    ```bash
    sudo apt install ./kubus-*-linux-x64.deb
    ```

    Launch **Kubus** from the application menu or run `kubus`.

    For other distributions, extract the installer archive and run its installer:

    ```bash
    tar -xzf linux-x64-Kubus-Setup.tar.gz
    ./installer
    ```

    The installer creates an application menu entry. Kubus requires GTK 3,
    WebKitGTK 4.1 and Ayatana AppIndicator 3. The `.deb` declares these dependencies
    so apt installs them automatically. Kubus uses the system webview; Chromium
    is not bundled.

!!! note "Why does macOS still warn?"

    Kubus is an open-source project without an Apple Developer or Windows code-signing
    certificate yet. macOS builds use ad-hoc signatures to seal their resources;
    these do not establish developer identity or provide Apple notarization.
    You can also [build from source](from-source.md).

## Updating

Installed macOS, Windows, and Linux archive builds check GitHub for a newer release
at startup and every six hours. These requests fetch release metadata; Kubus has
no telemetry and does not send your kubeconfig or cluster data with update checks.

Open **Settings → About → Updates** to check manually. When an update is available,
choose **Download update**, then **Restart and install** when ready. Restarting
closes active terminals and port forwards. Downloads and installation require
your action.

Debian packages use manual updates: download the newer `.deb` and install it with
`sudo apt install ./kubus-<version>-linux-x64.deb`. In-app updates are disabled for
these installations and for development builds.

Desktop state is stored in `kubus/desktop` under your platform’s application
configuration directory and survives updates.

On the first launch after upgrading from Electron, Kubus imports tabs, favorites,
theme, and UI preferences from the previous `Kubus/client-state.json` when no state
exists in the new directory. The original file is kept. Launches with a custom
`KUBUS_DESKTOP_DATA` directory do not import it.

## Next steps

<div class="grid cards" markdown>

-   :material-rocket-launch: **Quickstart**

    ---

    Connect your first cluster and take the tour.

    [:octicons-arrow-right-24: Quickstart](../quickstart.md)

</div>
