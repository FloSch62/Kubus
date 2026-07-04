---
icon: lucide/table
---

# Browsing resources

Pick a kind from the nav drawer and Kubus shows you a **live list** of every resource of
that kind, across all your selected clusters. Lists stay in sync over a WebSocket watch —
there's no refresh button because there's nothing to refresh.

<figure markdown="span">
  ![The Pods list](../assets/screenshots/pods.png#only-light){ .shadow }
  ![The Pods list](../assets/screenshots/pods-dark.png#only-dark){ .shadow }
  <figcaption>Live, sortable, filterable — with the right columns for each kind.</figcaption>
</figure>

## Live updates

Every list is backed by an informer-style watch. New objects appear, status changes
ripple through, and deletions drop out — instantly, with no flicker. If a watch is
interrupted (the classic Kubernetes `410 Gone`), Kubus transparently reconnects and
resyncs, so you can leave a list open all day and trust what it shows.

## Columns that fit the kind

Each built-in kind has hand-picked columns. Pods show readiness, status, restarts, CPU,
memory, node and age; Deployments show ready/up-to-date/available; Services show type and
ports — and so on. When several clusters are selected, a **Cluster** column is added
automatically.

- **Sort** by clicking a column header.
- **Filter** with the search box — plain text, or start with `/` for
  [smart filters](smart-filters.md): structured clauses like
  `/status:crash ns:prod restarts>3`, with autocomplete.
- **Labels** get their own column — each row shows its first labels as chips with a
  `+N` overflow; hover to see them all, click a chip to filter by that label.
- **Secret values are redacted** by default — Kubus never shows secret data in a list.
  [Reveal them deliberately](production-guard.md#secrets-are-redacted-by-default) in the
  details drawer.

## Custom resources, first-class

CRDs aren't an afterthought. Kubus discovers every CustomResourceDefinition in your
selected clusters and lists them under **Custom Resources**, grouped by API group. Even
better, it renders each CRD's own `additionalPrinterColumns` — the same extra columns you
get from `kubectl get` — as **real, sortable columns**.

<figure markdown="span">
  ![A custom resource list with printer columns](../assets/screenshots/crd-list.png#only-light){ .shadow }
  ![A custom resource list with printer columns](../assets/screenshots/crd-list-dark.png#only-dark){ .shadow }
  <figcaption>Your operators' CRDs, with their printer columns rendered as columns.</figcaption>
</figure>

!!! tip "Pick the right version automatically"

    When a CRD serves multiple versions, Kubus prefers the most stable, newest one
    (`v1` over `v1beta1` over `v1alpha1`) so you land on the version you almost certainly want.

## Filtering by namespace

The [namespace filter](clusters.md#filtering-by-namespace) in the top bar narrows every
list. Leave it empty for all namespaces; it applies across all selected clusters at once.

## Saved views

Got a list you keep coming back to — *failing pods in `prod`*, *all Ingresses in
`team-a`*? Save it. The current kind plus its namespace and cluster filters become a
**saved view** that appears in the nav drawer right under its kind, one click away. Delete
a saved view from the same spot when you're done with it.

## Acting on a row

Every row has a **⋮ menu** with the actions that make sense for that kind — logs, shell,
scale, restart, port-forward, delete, and more. That's covered in
[Quick actions](quick-actions.md). To inspect instead, just click the resource's **name**
to open the [details drawer](resource-details.md).

## See also

<div class="grid cards" markdown>

-   :material-file-document-edit: **[Resource details & YAML](resource-details.md)** — what's behind a row
-   :material-keyboard: **[Command palette](command-palette.md)** — jump to any resource with ++ctrl+k++

</div>
