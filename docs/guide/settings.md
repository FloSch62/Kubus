---
icon: lucide/settings
---

# Settings

Open settings from the **:material-cog: gear** in the top bar. Everything here is stored
in your browser/app profile — there's no server-side config file to manage.

<figure markdown="span">
  ![The settings dialog](../assets/screenshots/settings.png#only-light){ .shadow }
  ![The settings dialog](../assets/screenshots/settings-dark.png#only-dark){ .shadow }
  <figcaption>Appearance, refresh, logs and terminal — tuned to your taste.</figcaption>
</figure>

## Kubeconfig

Manage the kubeconfig entries Kubus knows about. The contexts here feed the
[cluster switcher](clusters.md).

## Clusters

Mark clusters as **protected**, or set **protect by default** so every cluster is guarded
until you say otherwise. See [Production guard](production-guard.md).

## Appearance

| Setting | Options | Default |
| --- | --- | --- |
| **Theme** | Light / Dark | Follows your OS |
| **Table density** | Compact / Comfortable | Compact |
| **Code font size** | 10–18 px | 12 px |

## Data & refresh { #data-refresh }

Kubus keeps **lists** live over a WebSocket watch no matter what. This setting controls the
**polling** cadence for things that aren't watched — metrics, events, Helm, the overview:

| Setting | Effect |
| --- | --- |
| **Fast** | Poll roughly twice as often |
| **Normal** | The default cadence |
| **Slow** | Poll about half as often |
| **Off** | Stop polling — useful on slow links or to save API calls |

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

## See also

<div class="grid cards" markdown>

-   :material-keyboard: **[Keyboard shortcuts](../reference/keyboard-shortcuts.md)**
-   :material-console-line: **[Command-line flags](../reference/cli.md)** — settings you pass at launch

</div>
