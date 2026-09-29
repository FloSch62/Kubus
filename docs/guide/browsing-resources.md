---
icon: lucide/table
---

# Browsing resources

Pick a kind from the nav drawer and Kubus shows you a **live list** of every resource of
that kind, across all your selected clusters. Lists stay in sync over a WebSocket watch.
There's no refresh button because there's nothing to refresh.

<figure markdown="span">
  ![The Pods list](../assets/screenshots/pods.png#only-light){ .shadow }
  ![The Pods list](../assets/screenshots/pods-dark.png#only-dark){ .shadow }
  <figcaption>Live, sortable and filterable, with the right columns for each kind.</figcaption>
</figure>

## Live updates

Every list is backed by an informer-style watch. New objects appear, status changes
ripple through and deletions drop out instantly, without flicker. If a watch is
interrupted (the classic Kubernetes `410 Gone`), Kubus reconnects and resyncs on its
own, so you can leave a list open all day and trust what it shows.

## Columns that fit the kind

Each built-in kind has hand-picked columns. Pods show readiness, status, restarts, CPU,
memory, node and age; Deployments show ready/up-to-date/available; Services show type and
ports. When several clusters are selected, a **Cluster** column is added automatically.

- **Sort** by clicking a column header. Names sort the way you read them: `worker-2`
  comes before `worker-10`, and a StatefulSet's pods line up as `web-1`, `web-2`, ...,
  `web-12`.
- **Filter** with the search box. Plain text works, or start with `/` for
  [smart filters](smart-filters.md): structured clauses like
  `/status:crash ns:prod restarts>3`, with autocomplete.
- **Labels** get their own column. Each row shows its first labels as chips with a
  `+N` overflow; hover to see them all, or click a chip to filter by that label.
- **Add a column for any label or annotation.** Click **Columns** in the toolbar, pick
  Label or Annotation, and choose a key. The picker suggests the keys present in the
  list and shows how many rows carry each one, and you can type any other key too. The
  new column shows that key's value per row, and you sort and filter it like any other
  column. Kubus keeps it with the list's other column settings (widths, visibility, sort),
  so it is still there after a reload, and a saved view brings it back. Remove it from
  the same **Columns** menu.
- **Copy a value** with the copy button that appears when you hover a cell, or focus a
  cell and press ++ctrl+c++ (++cmd+c++ on macOS). The shortcut always copies that one
  cell, even while rows are checked. To copy whole rows, use **Copy rows** (below).
- **Drive it from the keyboard.** Arrow keys or `j` / `k` move between rows, ++enter++
  opens one, and single keys act on the focused row: `l` logs, `x` shell, `s` scale,
  `e` manifest and [more](../reference/keyboard-shortcuts.md#single-key-row-actions).
- **Secret values are redacted** by default. Kubus never shows secret data in a list.
  [Reveal them deliberately](production-guard.md#secrets-are-redacted-by-default) in the
  details drawer.
- **Warnings find you.** A small amber marker next to the name flags any object with
  warning events or container restarts in the last hour; hover it for the reasons. Sort
  by that column and the noisiest objects come first. The same signal puts a count on the
  drawer's Events tab and a dot on a page tab whose object turned unhealthy while you
  were looking elsewhere.

## Kubus remembers where you were

Nothing resets behind your back. Each kind remembers the filter, label selector and
scroll position you left it with, and opening the kind again from the nav brings them
back. Clearing the filter forgets it, and the empty state offers a **Clear filters**
button when a filter hides everything. Saved views and deep links carry their own query
and are never overridden.

The [namespace filter](clusters.md#filtering-by-namespace) is remembered per cluster too,
so switching to the prod cluster lands on the namespace you use there.

## Custom resources, first-class

CRDs aren't an afterthought. Kubus discovers every CustomResourceDefinition in your
selected clusters and lists them under **Custom Resources**, grouped by API group. It also
renders each CRD's own `additionalPrinterColumns` (the same extra columns you get from
`kubectl get`) as real, sortable columns.

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

If there's a list you keep coming back to, such as *failing pods in `prod`* or *all
Ingresses in `team-a`*, save it. The current kind plus its namespace and cluster filters
become a **saved view** that appears in the nav drawer right under its kind, one click
away. Delete a saved view from the same spot when you're done with it.

## Acting on a row

Every row has a **⋮ menu** with the actions that make sense for that kind: logs, shell,
scale, restart, port-forward, delete and more. That's covered in
[Quick actions](quick-actions.md). To inspect instead, click the resource's **name** to
open the [details drawer](resource-details.md).

Tick the checkboxes to act on several rows at once. The toolbar then offers actions for
the checked rows:

- **Copy rows** puts the checked rows on the clipboard with the columns you see, header
  included. Pick **TSV** to paste into a spreadsheet or **CSV** for a file. Values are
  the raw data behind each cell, so ages come out as timestamps and memory in bytes.
- **Scale** (Deployments and StatefulSets) sets one replica count on all of them. See
  [scaling several workloads](quick-actions.md#scaling).
- **Restart** (Deployments, StatefulSets, DaemonSets), **Logs** (Pods) and **Delete**
  work the same way.

## See also

<div class="grid cards" markdown>

-   :material-file-document-edit: **[Resource details & YAML](resource-details.md)** shows what's behind a row.
-   :material-keyboard: **[Command palette](command-palette.md)** jumps to any resource with ++ctrl+k++.

</div>
