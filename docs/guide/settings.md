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

Shows which kubeconfig file(s) Kubus is reading and where that choice came from
(`--kubeconfig` flag, `$KUBECONFIG`, a saved override, or the default). Point Kubus at a
different file with **Override path**.

## Clusters

The home for managing the clusters in your kubeconfig:

- **Add cluster** — paste or fill in a new cluster.
- **Edit** (:material-pencil:) — change a cluster's API server, credentials, TLS, and
  proxy settings. See [Adding, editing & removing clusters](clusters.md#adding-editing-removing-clusters) and
  [Reaching clusters behind a proxy or bastion](clusters.md#reaching-clusters-behind-a-proxy-or-bastion).
- **Protect** (:material-shield:) — mark a cluster as protected, or set **protect by
  default** so every cluster is guarded until you say otherwise. See
  [Production guard](production-guard.md).

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
