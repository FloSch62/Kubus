---
icon: lucide/layout
---

# The Kubus window

Everything in Kubus happens in a single window with four regions. Once you know them,
the whole app makes sense.

<figure markdown="span">
  ![The Kubus window, annotated](../assets/screenshots/overview.png#only-light){ .shadow }
  ![The Kubus window, annotated](../assets/screenshots/overview-dark.png#only-dark){ .shadow }
  <figcaption>The Overview page, showing the top bar, nav drawer and content area.</figcaption>
</figure>

## :material-dock-top: Top bar

The strip along the top is always available, whatever page you're on:

| Control | What it does |
| --- | --- |
| **Cluster switcher** | Select which kubeconfig contexts are active. [More →](clusters.md) |
| **Namespace filter** | Restrict every list to one or more namespaces. [More →](clusters.md#filtering-by-namespace) |
| **Search** (++ctrl+k++) | Open the [command palette](command-palette.md) to find and act on anything. |
| **Theme toggle** | Flip between light and dark. |
| **Settings** (:material-cog:) | Appearance, refresh rate, log and terminal preferences. [More →](settings.md) |

## :material-dock-left: Navigation drawer

The left drawer lists every resource kind, grouped into **Workloads, Network, Config,
Storage, Cluster** and **Access Control** — plus a **Custom Resources** group that's
populated automatically from the CRDs discovered in your selected clusters.

- Type in the **filter box** at the top to jump to a kind.
- **Saved views** appear under their kind once you save a filtered list.
- Dedicated pages — **Overview, Events, Helm, Port Forwards, Diff, Topology** — sit
  alongside the resource groups.

[More on the nav & saved views :octicons-arrow-right-24:](browsing-resources.md#saved-views)

## :material-card-text-outline: Content area

The middle is where the current page renders — a resource list, the overview dashboard,
the Helm page, and so on. Clicking a resource opens the **details drawer** on the right
without leaving the page.

## :material-dock-bottom: Bottom dock

Logs and terminals open in a **dock** along the bottom of the window. Each log stream or
shell gets its own tab, so you can keep several open at once. You can:

- **resize** the dock by dragging its top edge,
- **maximise** it to fill the window,
- **toggle** it with the command *Toggle terminal dock* (++ctrl+k++ → `>`).

[More on logs](logs.md) · [More on shells](shell.md)

## :material-page-layout-sidebar-right: Details drawer

Click any resource name and a drawer slides in from the right with tabs for the
**Overview**, **YAML**, **Events**, a relationship **Map**, and — depending on the kind —
**Metrics** or rollout **History**. Open another resource from inside it (a pod's node, a
referenced ConfigMap) and Kubus keeps a back-stack so you can navigate and return.

[More on the details drawer :octicons-arrow-right-24:](resource-details.md)
