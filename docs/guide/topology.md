---
icon: lucide/git-fork
---

# Topology

The **Topology** view draws the relationships between your resources as a graph — which
Deployment owns which ReplicaSet owns which Pods, what Service selects them, what
ConfigMaps and Secrets they mount. Sometimes a picture is the fastest way to understand
what's wired to what.

<figure markdown="span">
  ![The topology graph](../assets/screenshots/topology.png#only-light){ .shadow }
  ![The topology graph](../assets/screenshots/topology-dark.png#only-dark){ .shadow }
  <figcaption>Resources as nodes, ownership and references as edges.</figcaption>
</figure>

## Two ways in

- **Full page** — open **Topology** from the nav (or ++ctrl+k++ → *Go to Topology*) for a
  graph of the current namespace/cluster scope.
- **Focused** — the **Map** tab in any [details drawer](resource-details.md) shows a graph
  centred on that one object and its immediate neighbours.

## Reading the graph

- **Nodes** are resources; **edges** are ownership or references.
- The [namespace filter](clusters.md#filtering-by-namespace) scopes what's drawn.
- Toggle **hide disconnected** to drop isolated resources and focus on what's actually
  connected.
- Click a node to open its [details drawer](resource-details.md) and dig in.

!!! tip "Tracing a problem"

    Start from a failing pod's **Map** tab and walk outward — to its owner, its service,
    its config — to find where the chain breaks.

## See also

<div class="grid cards" markdown>

-   :material-file-document-edit: **[Resource details](resource-details.md)** — the Map tab, focused on one object
-   :material-table: **[Browsing resources](browsing-resources.md)** — the list view of the same objects

</div>
