---
icon: lucide/book-open
---

# User guide

Welcome to the Kubus guide. Each page here covers one part of the app, with screenshots
and step-by-step instructions. You don't have to read it in order. Jump to whatever
you're trying to do.

## Browse, inspect, act

The whole app in three moves:

=== "Browse"

    Pick your clusters, pick a kind, and you get a live list that updates over a
    WebSocket watch, with no refresh button to press. CRDs show their own
    `additionalPrinterColumns`.

    ![Pods list with live status](../assets/screenshots/pods.png#only-light){ .shadow }
    ![Pods list with live status](../assets/screenshots/pods-dark.png#only-dark){ .shadow }

=== "Inspect"

    Click any resource to slide open a details drawer with a human overview, a
    Monaco-powered YAML editor, events, a relationship map and (for pods/nodes) metrics.

    ![Resource details drawer](../assets/screenshots/pod-detail.png#only-light){ .shadow }
    ![Resource details drawer](../assets/screenshots/pod-detail-dark.png#only-dark){ .shadow }

=== "Act"

    Scale, restart, roll back, trigger a CronJob, cordon or drain a node, open a shell,
    forward a port. Each action is available from a row menu, the detail drawer or the
    command palette.

    ![Resource diff across clusters](../assets/screenshots/diff.png#only-light){ .shadow }
    ![Resource diff across clusters](../assets/screenshots/diff-dark.png#only-dark){ .shadow }

## Start here

<div class="grid cards" markdown>

-   :material-application-outline: **The Kubus window**

    ---

    A tour of the top bar, nav drawer, content area and bottom dock.

    [:octicons-arrow-right-24: The window](the-window.md)

-   :material-kubernetes: **Connecting clusters**

    ---

    Select contexts, filter namespaces, and work across many clusters at once.

    [:octicons-arrow-right-24: Clusters](clusters.md)

</div>

## Browse & inspect

<div class="grid cards" markdown>

-   :material-view-dashboard: **[Overview dashboard](overview.md)** gives you cluster health at a glance.
-   :material-table: **[Browsing resources](browsing-resources.md)** covers lists, columns, CRDs and saved views.
-   :material-file-document-edit: **[Resource details & YAML](resource-details.md)** covers the drawer and the editor.
-   :material-chart-areaspline: **[Metrics & health](metrics.md)** charts CPU and memory history.
-   :material-bell-outline: **[Events](events.md)** is a live, deduplicated timeline.
-   :material-graph-outline: **[Topology](topology.md)** shows how resources relate.
-   :material-compare: **[Comparing resources](diff.md)** diffs two YAML documents side by side.

</div>

## Operate

<div class="grid cards" markdown>

-   :material-lightning-bolt: **[Quick actions](quick-actions.md)** covers scale, restart, roll back, cordon and drain.
-   :material-script-text: **[Logs](logs.md)** explains the aggregated, colour-coded, filterable log view.
-   :material-console: **[Shell, debug & node shell](shell.md)** opens terminals into containers and nodes.
-   :material-lan-connect: **[Port forwarding](port-forwarding.md)** lets you reach any pod or service.
-   :material-file-tree: **[Copying files](copying-files.md)** covers upload and download, like `kubectl cp`.
-   :material-ship-wheel: **[Helm releases](helm.md)** covers values, history, rollback and uninstall.

</div>

## Power tools

<div class="grid cards" markdown>

-   :material-keyboard: **[Command palette](command-palette.md)** puts everything behind ++ctrl+k++.
-   :material-shield-alert: **[Production guard & secrets](production-guard.md)** adds guard rails for risky clusters.
-   :material-cog: **[Settings](settings.md)** covers appearance, refresh, logs and terminal.

</div>
