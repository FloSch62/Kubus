---
icon: lucide/bell
---

# Events

The **Events** page is a live, cluster-wide timeline of everything Kubernetes is telling
you — scheduling decisions, image pulls, probe failures, evictions — deduplicated and
filterable, across every selected cluster.

<figure markdown="span">
  ![The cluster-wide events timeline](../assets/screenshots/events.png#only-light){ .shadow }
  ![The cluster-wide events timeline](../assets/screenshots/events-dark.png#only-dark){ .shadow }
  <figcaption>Every event, deduplicated, with a warnings-only switch for triage.</figcaption>
</figure>

## What you get

- **Live** — events stream in as they happen.
- **Deduplicated** — repeated events (same object, reason and message) collapse into one
  row with a count, instead of flooding the list.
- **Cross-cluster** — a Cluster column when you've selected more than one.
- **Columns** — type, reason, involved object, message, namespace, count and last-seen.

## Filtering

| Filter | Use it to… |
| --- | --- |
| **Warnings only** | Hide the `Normal` noise and see just what's wrong. |
| **Kind** | Focus on one object kind (Pods, Nodes…). |
| **Text search** | Match on reason or message. |
| **Namespace** | The top-bar [namespace filter](clusters.md#filtering-by-namespace) applies here too. |

## Jump to the object

Click the involved object in any row and Kubus opens its
[details drawer](resource-details.md) — go straight from *"something's wrong"* to the
thing that's wrong.

!!! tip "From the Overview"

    The **Warnings (last hour)** panel on the [Overview](overview.md) is a shortcut into
    this page, pre-filtered to recent warnings.

## See also

<div class="grid cards" markdown>

-   :material-view-dashboard: **[Overview dashboard](overview.md)** — the warnings rollup
-   :material-script-text: **[Logs](logs.md)** — once an event points you at a pod

</div>
