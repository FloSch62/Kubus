---
icon: lucide/command
---

# Command palette

The command palette is the fastest way to drive Kubus. One shortcut, and you can find any
resource, run any action on it, or jump to any page — without lifting your hands off the
keyboard.

<figure markdown="span">
  ![The command palette](../assets/screenshots/command-palette.png#only-light){ .shadow }
  ![The command palette](../assets/screenshots/command-palette-dark.png#only-dark){ .shadow }
  <figcaption>Press ++ctrl+k++ and start typing.</figcaption>
</figure>

## Open it

Press ++ctrl+k++ (++cmd+k++ on macOS), or click the search box in the top bar.

## Three modes

=== "Search (default)"

    Just start typing. The palette searches across **resources** (of every kind, in every
    selected cluster), **kinds**, and **pages**. Use ++up++ / ++down++ to move and
    ++enter++ to open.

    With nothing typed, it shows your **favourites** — star a result (press ++tab++ to
    reveal the star) to pin things you open a lot.

=== "Actions (++tab++)"

    Highlight a resource and press ++tab++ (or ++right++) to see **every action** for that
    kind — logs, shell, scale, restart, port-forward, delete and the rest. Type to filter
    them, ++enter++ to run. Press ++esc++ to step back to the search.

=== "Commands (`>`)"

    Type `>` to run **app commands**:

    | Command | Does |
    | --- | --- |
    | Toggle dark / light mode | Flip the theme |
    | Toggle terminal dock | Show/hide the bottom dock |
    | Go to Overview | Jump to the dashboard |
    | Go to Events | Open the events timeline |
    | Go to Topology | Open the topology graph |
    | Go to Helm Releases | Open the Helm page |
    | Go to Port Forwards | Open the forwards page |
    | Go to Diff | Open the diff page |

## Why it's worth the muscle memory

Once ++ctrl+k++ is in your fingers, the workflow becomes: *summon → type a pod name →
++tab++ → logs*. No nav drawer, no scrolling a list, no row menus. It's the same instinct
as the command palette in your editor — and it covers the whole app.

## See also

<div class="grid cards" markdown>

-   :material-keyboard: **[Keyboard shortcuts](../reference/keyboard-shortcuts.md)** — the full reference
-   :material-lightning-bolt: **[Quick actions](quick-actions.md)** — what those actions do

</div>
