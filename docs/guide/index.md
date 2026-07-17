---
icon: lucide/book-open
---

# User guide

Welcome to the Kubus guide. Each page here covers one part of the app, with screenshots
and step-by-step instructions. You don't have to read it in order — jump to whatever
you're trying to do.

## Browse, inspect, act

The whole app in three moves:

=== "Browse"

    Pick your clusters, pick a kind, and you get a live list that updates over a
    WebSocket watch — no refresh button. CRDs show their own `additionalPrinterColumns`.

    ![Pods list with live status](../assets/screenshots/pods.png#only-light){ .shadow }
    ![Pods list with live status](../assets/screenshots/pods-dark.png#only-dark){ .shadow }

=== "Inspect"

    Click any resource to slide open a details drawer with a human overview, a
    Monaco-powered YAML editor, events, a relationship map and (for pods/nodes) metrics.

    ![Resource details drawer](../assets/screenshots/pod-detail.png#only-light){ .shadow }
    ![Resource details drawer](../assets/screenshots/pod-detail-dark.png#only-dark){ .shadow }

=== "Act"

    Scale, restart, roll back, trigger a CronJob, cordon or drain a node, open a shell,
    forward a port — all from a row menu, the detail drawer or the command palette.

    ![Resource diff across clusters](../assets/screenshots/diff.png#only-light){ .shadow }
    ![Resource diff across clusters](../assets/screenshots/diff-dark.png#only-dark){ .shadow }

## Start here

<div class="grid cards" markdown>

-   :material-application-outline: **The Kubus window**

    ---

    The top bar, nav drawer, content area and bottom dock — what's where and why.

    [:octicons-arrow-right-24: The window](the-window.md)

-   :material-kubernetes: **Connecting clusters**

    ---

    Select contexts, filter namespaces, and work across many clusters at once.

    [:octicons-arrow-right-24: Clusters](clusters.md)

</div>

## Browse & inspect

<div class="grid cards" markdown>

-   :material-view-dashboard: **[Overview dashboard](overview.md)** — cluster health at a glance
-   :material-table: **[Browsing resources](browsing-resources.md)** — lists, columns, CRDs, saved views
-   :material-file-document-edit: **[Resource details & YAML](resource-details.md)** — the drawer and the editor
-   :material-chart-areaspline: **[Metrics & health](metrics.md)** — CPU/memory history
-   :material-bell-outline: **[Events](events.md)** — a live, deduplicated timeline
-   :material-graph-outline: **[Topology](topology.md)** — see how resources relate
-   :material-compare: **[Comparing resources](diff.md)** — side-by-side YAML diff

</div>

## Operate

<div class="grid cards" markdown>

-   :material-lightning-bolt: **[Quick actions](quick-actions.md)** — scale, restart, roll back, cordon, drain
-   :material-script-text: **[Logs](logs.md)** — aggregated, colour-coded, filterable
-   :material-console: **[Shell, debug & node shell](shell.md)** — terminals into containers and nodes
-   :material-lan-connect: **[Port forwarding](port-forwarding.md)** — reach any pod or service
-   :material-file-tree: **[Copying files](copying-files.md)** — upload and download like `kubectl cp`
-   :material-ship-wheel: **[Helm releases](helm.md)** — values, history, rollback, uninstall

</div>

## Power tools

<div class="grid cards" markdown>

-   :material-keyboard: **[Command palette](command-palette.md)** — ++ctrl+k++ for everything
-   :material-shield-alert: **[Production guard & secrets](production-guard.md)** — guard rails for risky clusters
-   :material-cog: **[Settings](settings.md)** — appearance, refresh, logs and terminal

</div>
