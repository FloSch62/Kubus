---
icon: lucide/settings
---

# Settings

Open settings from the **:material-cog: gear** in the top bar. Nearly everything here is
stored in your browser/app profile. The one exception is the debug image catalog, which
the server keeps in `settings.json` so the images are available from any window.

<figure markdown="span">
  ![The settings dialog](../assets/screenshots/settings.png#only-light){ .shadow }
  ![The settings dialog](../assets/screenshots/settings-dark.png#only-dark){ .shadow }
  <figcaption>Appearance, refresh, logs and terminal settings.</figcaption>
</figure>

## Kubeconfig

Shows which kubeconfig file(s) Kubus is reading and where that choice came from
(`--kubeconfig` flag, `$KUBECONFIG`, a saved override, or the default). Point Kubus at a
different file with **Override path**.

## Clusters

The home for managing the clusters in your kubeconfig:

- **Add cluster** lets you paste or fill in a new cluster.
- **Edit** (:material-pencil:) changes a cluster's API server, credentials, TLS and
  proxy settings. See [Adding, editing & removing clusters](clusters.md#adding-editing-removing-clusters) and
  [Reaching clusters behind a proxy or bastion](clusters.md#reaching-clusters-behind-a-proxy-or-bastion).
- **Protect** (:material-shield:) marks a cluster as protected. You can also set
  **protect by default** so every cluster is guarded until you say otherwise. See
  [Production guard](production-guard.md).

## Appearance

| Setting | Options | Default |
| --- | --- | --- |
| **Theme** | Light / Dark | Follows your OS |
| **Table density** | Compact / Comfortable | Compact |
| **Code font size** | 10 to 18 px | 12 px |

## Data & refresh { #data-refresh }

Kubus keeps **lists** live over a WebSocket watch no matter what. Metrics, events, Helm and
the overview are polled instead, and this setting controls how often:

| Setting | Effect |
| --- | --- |
| **Fast** | Poll roughly twice as often |
| **Normal** | The default cadence |
| **Slow** | Poll about half as often |
| **Off** | Stop polling. Useful on slow links or to save API calls |

## Logs & terminal { #logs-terminal }

Defaults for the [log viewer](logs.md) and [terminals](shell.md):

**Logs**

| Setting | Options | Default |
| --- | --- | --- |
| Tail lines | 100 / 500 / 1000 / 5000 | 500 |
| Wrap long lines | on / off | off |
| Syntax highlighting | on / off | on |
| Timestamps | Hidden / Local / UTC | Hidden |

**Terminal**

| Setting | Options | Default |
| --- | --- | --- |
| Default shell | Auto (`bash`→`sh`) / `sh` / `bash` / custom path | Auto |

## Debug containers { #debug-containers }

The image catalog offered by the [debug container](shell.md#debug-containers)
dialog. The built-in presets (busybox, the DebugBox tiers, netshoot) are listed
alongside your own entries. Add an internal toolbox image, a different busybox
tag, or anything else your registry serves. Each entry has a name, an image reference,
an optional description and an optional security profile that is pre-selected
with it. An entry named like a built-in preset replaces it.

Your entries are stored server-side in `settings.json` (key `debugImages`),
next to your Helm repositories.

## See also

<div class="grid cards" markdown>

-   :material-keyboard: **[Keyboard shortcuts](../reference/keyboard-shortcuts.md)** lists every shortcut.
-   :material-console-line: **[Command-line flags](../reference/cli.md)** are the settings you pass at launch.

</div>
