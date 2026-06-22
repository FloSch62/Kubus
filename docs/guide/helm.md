---
icon: lucide/ship-wheel
---

# Helm releases

Kubus speaks Helm natively — **no `helm` binary required**. The server reads and decodes
release secrets directly, so you can inspect and manage releases from the UI.

<figure markdown="span">
  ![The Helm releases list](../assets/screenshots/helm-list.png#only-light){ .shadow }
  ![The Helm releases list](../assets/screenshots/helm-list-dark.png#only-dark){ .shadow }
  <figcaption>Every release across your selected clusters, with status and versions.</figcaption>
</figure>

## The releases list

Open **Helm** from the nav (or ++ctrl+k++ → *Go to Helm Releases*). You get every release
across your selected clusters, with namespace, status, chart and app version, revision and
last-updated. It honours the [namespace filter](clusters.md#filtering-by-namespace), and
shows a Cluster column when several are selected. Click a release to open it.

## Inside a release

<figure markdown="span">
  ![A Helm release detail with its tabs](../assets/screenshots/helm-detail.png#only-light){ .shadow }
  ![A Helm release detail with its tabs](../assets/screenshots/helm-detail-dark.png#only-dark){ .shadow }
  <figcaption>Values, computed values, manifest, history and notes — all read-only and safe to browse.</figcaption>
</figure>

| Tab | Shows |
| --- | --- |
| **Values** | The values *you* supplied at install/upgrade. |
| **Computed values** | The fully-merged values Helm actually used (your values + chart defaults). |
| **Manifest** | The rendered Kubernetes manifests for the release. |
| **History** | Every revision, with chart/app version, change-cause and a **Roll back** button. |
| **Notes** | The release `NOTES.txt`, if the chart provides one. |

## Rollback & uninstall

- **Roll back** — from the History tab, return the release to any earlier revision. Helm
  records it as a new revision, so the trail stays intact.
- **Uninstall** — remove the release and all its resources.

!!! warning "Helm hooks aren't run"

    Because Kubus manages releases directly rather than shelling out to `helm`, **lifecycle
    hooks are not executed** on rollback or uninstall. For charts that depend on
    pre-delete or post-rollback hooks, use the `helm` CLI.

!!! danger "Protected clusters"

    On a [protected cluster](production-guard.md), rollback and uninstall require you to
    type the release name first.

## See also

<div class="grid cards" markdown>

-   :material-file-document-edit: **[Resource details](resource-details.md)** — inspect the objects a release created
-   :material-compare: **[Comparing resources](diff.md)** — diff a release's objects across clusters

</div>
