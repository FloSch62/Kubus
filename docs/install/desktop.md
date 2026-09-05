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

        - **Right-click** the app → **Open**, then confirm in the dialog, *or*
        - clear the quarantine flag from a terminal:

        ```bash
        xattr -d com.apple.quarantine /Applications/Kubus.app
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

!!! note "Why isn't it signed?"

    Kubus is an open-source project without an Apple Developer or Windows code-signing
    certificate yet. The steps above are the standard way to run unsigned apps. You can
    always [build from source](from-source.md) if you'd rather not.

## Updating

Download the newer installer and install over the top. Desktop state is stored in
`kubus/desktop` under your platform’s application configuration directory and survives updates. There's no telemetry and no auto-updater phoning
home.

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
