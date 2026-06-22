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
| :material-microsoft-windows: Windows | `Kubus-Setup-<version>.exe` |
| :material-apple: macOS (universal) | `Kubus-<version>.dmg` |
| :material-linux: Linux | `Kubus-<version>.AppImage` or `.deb` |

## Install & launch

=== ":material-microsoft-windows: Windows"

    1. Run the `.exe` installer and follow the prompts.
    2. Launch **Kubus** from the Start menu.

    Windows SmartScreen may warn that the publisher is unrecognised (the builds aren't
    code-signed yet). Choose **More info → Run anyway**.

=== ":material-apple: macOS"

    1. Open the `.dmg` and drag **Kubus** into **Applications**.
    2. The builds aren't notarised yet, so the first launch needs one extra step:

        - **Right-click** the app → **Open**, then confirm in the dialog, *or*
        - clear the quarantine flag from a terminal:

        ```bash
        xattr -dr com.apple.quarantine /Applications/Kubus.app
        ```

    After the first launch you can open it normally from Spotlight or the Dock.

=== ":material-linux: Linux"

    === "AppImage"

        ```bash
        chmod +x Kubus-*.AppImage
        ./Kubus-*.AppImage
        ```

    === "Debian / Ubuntu (.deb)"

        ```bash
        sudo apt install ./kubus_*_amd64.deb
        kubus
        ```

!!! note "Why isn't it signed?"

    Kubus is an open-source project without an Apple Developer or Windows code-signing
    certificate yet. The steps above are the standard way to run unsigned apps. You can
    always [build from source](from-source.md) if you'd rather not.

## Updating

Download the newer installer and install over the top — your settings live in the
browser/app profile and are preserved. There's no telemetry and no auto-updater phoning home.

## Next steps

<div class="grid cards" markdown>

-   :material-rocket-launch: **Quickstart**

    ---

    Connect your first cluster and take the tour.

    [:octicons-arrow-right-24: Quickstart](../quickstart.md)

</div>
