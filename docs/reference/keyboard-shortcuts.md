---
icon: lucide/keyboard
---

# Keyboard shortcuts

Kubus is designed to be driven from the keyboard. The [command palette](../guide/command-palette.md)
is the hub, and almost everything is reachable through it.

## Global

| Shortcut | Action |
| --- | --- |
| ++ctrl+k++ / ++cmd+k++ | Open the command palette |

## Resource tables

| Shortcut | Action |
| --- | --- |
| ++ctrl+f++ / ++cmd+f++ | Focus the table search |
| `s` / `:` / `/` | Focus the table search (on a row that can scale, `s` scales it instead) |
| `c` | Create a resource of this kind |
| ++up++ / ++down++ or `j` / `k` | Move the row cursor |
| ++enter++ | Open details for the focused row |
| ++shift+f10++ | Open the focused row's actions menu |

### Single-key row actions

Focus a row (click one of its cells, or move there with the arrow keys) and a single key
runs an action on it. Each key only works where the row has that action, and it goes
through the same dialogs as the row menu, which prints the key next to each item. The
keys never fire while you type in the filter box, the YAML editor or a terminal.

| Key | Action | Applies to |
| --- | --- | --- |
| `l` | Logs | Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Services, Jobs |
| `x` | Shell | Pods with a running container. On a Node, a node shell after you confirm. |
| `f` | Port forward | Pods, Services, Deployments, StatefulSets, DaemonSets, ReplicaSets |
| `s` | Scale | Deployments, StatefulSets, ReplicaSets |
| `r` | Restart, after you confirm | Deployments, StatefulSets, DaemonSets. A ReplicaSet restarts its pods. |
| `e` | Open the Manifest tab | Every kind |
| ++del++ or ++backspace++ | Delete, after you confirm | Every kind |

On a [protected cluster](../guide/production-guard.md), the confirmations for delete,
restart, node shell and scale to zero ask you to type the resource name first.

## Details panel

| Shortcut | Action |
| --- | --- |
| `e` | Open the Manifest tab |
| ++alt+left++ | Back to the previous resource |
| ++esc++ | Close the panel and return to the list |

## Manifest editing

| Shortcut | Action |
| --- | --- |
| ++ctrl+s++ / ++cmd+s++ | Open **Review & apply** for your staged edits, in the tree and the YAML view. Inside the review, apply once the dry-run passes. An inline value you are still editing is committed first. |
| ++ctrl+enter++ / ++cmd+enter++ | Create, in a create dialog. Edited YAML gets its server dry-run first, and any findings stop it so you can read them. |

## Bottom dock (logs & terminals)

| Shortcut | Action |
| --- | --- |
| ++ctrl+w++ / ++cmd+w++ | Close the focused log or terminal tab |
| ++alt+page-up++ / ++alt+page-down++ | Previous / next tab in the focused dock |
| ++ctrl+page-up++ / ++ctrl+page-down++ | Previous / next tab in the focused dock (desktop app) |

Tab-cycling shortcuts switch page tabs when focus is outside the dock.

When the dock is empty, ++ctrl+w++ / ++cmd+w++ closes the Kubus window as usual.

!!! note "Desktop app only"

    Closing a tab with ++ctrl+w++ / ++cmd+w++ is handled by the Kubus desktop app.
    In a browser tab that shortcut is reserved by the browser and closes the tab
    instead; use the tab's **×** button there.

## Inside the command palette

| Key | Action |
| --- | --- |
| *type* | Search resources, kinds and pages |
| ++up++ / ++down++ | Move between results |
| ++enter++ | Open / activate the selected result |
| ++tab++ / ++right++ | Show actions for the selected resource |
| ++right++ / ++enter++ | Expand a folded group of pods; ++left++ folds it again |
| ++tab++ | Reveal the star to favourite a result |
| `>` | Switch to **command** mode (app commands) |
| ++esc++ | Step back, or close the palette |

In the actions list, an action that also has a [single-key row action](#single-key-row-actions)
shows its key on the right.

## App commands (`>`)

Type `>` in the palette to run:

| Command |
| --- |
| Toggle dark / light mode |
| Toggle terminal dock |
| Go to Overview |
| Go to Events |
| Go to Topology |
| Go to Helm Releases |
| Go to Port Forwards |
| Go to Diff |

!!! tip "The fast path"

    ++ctrl+k++ → type a name → ++tab++ → pick **Logs** or **Shell**. That single muscle
    memory covers most of day-to-day work.

## See also

<div class="grid cards" markdown>

-   :material-command: **[Command palette](../guide/command-palette.md)** has the full walkthrough.

</div>
