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
    2. Launch **Kubus** from Applications, Spotlight, or the Dock. Confirm the
       standard first-open prompt if macOS asks.

    Published release builds are Developer ID signed and notarized by Apple.

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

!!! note "Local and pull-request macOS builds"

    Local and pull-request builds use ad-hoc signatures and are not notarized.
    For a build you trust, use **System Settings → Privacy & Security → Open Anyway**
    if offered after the first launch attempt, then confirm.
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
