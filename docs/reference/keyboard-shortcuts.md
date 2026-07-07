---
icon: lucide/keyboard
---

# Keyboard shortcuts

Kubus is designed to be driven from the keyboard. The [command palette](../guide/command-palette.md)
is the hub — almost everything is reachable through it.

## Global

| Shortcut | Action |
| --- | --- |
| ++ctrl+k++ / ++cmd+k++ | Open the command palette |

## Resource tables

| Shortcut | Action |
| --- | --- |
| ++ctrl+f++ / ++cmd+f++ | Focus the table search |
| `s` / `:` | Focus the table search |

## Bottom dock (logs & terminals)

| Shortcut | Action |
| --- | --- |
| ++ctrl+w++ / ++cmd+w++ | Close the focused log or terminal tab |

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
| ++tab++ | Reveal the star to favourite a result |
| `>` | Switch to **command** mode (app commands) |
| ++esc++ | Step back, or close the palette |

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

-   :material-command: **[Command palette](../guide/command-palette.md)** — the full walkthrough

</div>
