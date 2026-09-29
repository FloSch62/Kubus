---
icon: lucide/git-fork
---

# Topology

The **Topology** view draws the relationships between your resources as a graph: which
Deployment owns which ReplicaSet owns which Pods, what Service selects them, what
ConfigMaps and Secrets they mount. Sometimes a picture is the fastest way to understand
what's wired to what.

<figure markdown="span">
  ![The topology graph](../assets/screenshots/topology.png#only-light){ .shadow }
  ![The topology graph](../assets/screenshots/topology-dark.png#only-dark){ .shadow }
  <figcaption>Resources as nodes, ownership and references as edges.</figcaption>
</figure>

## Two ways in

- **Full page**: open **Topology** from the nav (or ++ctrl+k++ → *Go to Topology*) for a
  graph of the current namespace/cluster scope.
- **Focused**: the **Map** tab in any [details drawer](resource-details.md) shows a graph
  centred on that one object and its immediate neighbours.

## Reading the graph

- **Nodes** are resources; **edges** are ownership or references. The legend at the bottom
  names each edge colour, and dashed edges carry traffic (routes and selectors).
- The [namespace filter](clusters.md#filtering-by-namespace) scopes what's drawn.
- **Only connected** (on by default) drops isolated resources so you see what's actually
  wired together. Turn it off to include everything in scope.
- Old ReplicaSets that no longer run pods fold into one dashed card per Deployment. Click
  that card, or turn on **Old ReplicaSets** in the header, to show them individually.
- Click a node to highlight its links and name them. Double-click it to open its
  [details drawer](resource-details.md) and dig in.
- The graph opens at a zoom where names stay readable. When it is larger than the screen,
  drag to pan and use the minimap in the corner to jump around; the fit button in the
  controls zooms out to show everything at once.

!!! tip "Tracing a problem"

    Start from a failing pod's **Map** tab and walk outward through its owner, its service
    and its config until you find where the chain breaks.

## See also

<div class="grid cards" markdown>

-   :material-file-document-edit: **[Resource details](resource-details.md)** has the Map tab, focused on one object.
-   :material-table: **[Browsing resources](browsing-resources.md)** is the list view of the same objects.

</div>
