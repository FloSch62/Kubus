---
icon: lucide/ship-wheel
---

# Helm releases

Kubus speaks Helm natively — **no `helm` binary required**. The server reads and decodes
release records directly (secret *and* configmap storage drivers), and renders charts with
Helm's own engine compiled to WebAssembly. That covers the full lifecycle: browse
repositories, install, edit values, upgrade, roll back and uninstall — hooks included.

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

## Installing charts

Hit **Install chart** on the releases page. **Artifact Hub search is built in** — type any
chart name (harbor, cert-manager, nginx…) and every public chart is there, official and
verified publishers flagged, no repository setup needed. You can still add your own
repositories (e.g. `prometheus-community` → `https://prometheus-community.github.io/helm-charts`)
for private or unlisted charts and browse their catalogs the same way. Pick a chart and
you get:

- a **version picker** across everything the repo publishes,
- the chart's **default values** in an editor, plus its **README**,
- release name, target cluster/namespace (with *create namespace*),
- **Preview manifest** — the fully rendered resources before anything is applied.

Charts served from OCI registries (`oci://registry-1.docker.io/bitnamicharts/nginx`) or a
direct `.tgz` URL install through the same dialog — paste the ref, pick the version, go.

## Editing values & upgrading

**Upgrade** on the release detail opens the release's current user-supplied values in an
editor — the moment other tools send you back to a terminal. Change what you need, keep
the current chart or pick a newer version — Kubus resolves the chart across your
configured repositories **and Artifact Hub**, so any public chart offers its full version
history with zero setup — then **Preview changes** to see a side-by-side diff of the
current manifest against the newly rendered one. Upgrade writes the next revision exactly like the helm CLI
would: previous records are superseded, history stays intact, and the `helm` CLI sees
everything Kubus wrote.

Rendering happens server-side with Helm's real template engine (compiled from
`helm.sh/helm/v3` to WASM), against your cluster's actual capabilities — kube version and
available API groups — so `.Capabilities`-conditional templates render correctly.

## Inside a release

<figure markdown="span">
  ![A Helm release detail with its tabs](../assets/screenshots/helm-detail.png#only-light){ .shadow }
  ![A Helm release detail with its tabs](../assets/screenshots/helm-detail-dark.png#only-dark){ .shadow }
  <figcaption>Values, computed values, manifest, history and notes.</figcaption>
</figure>

| Tab | Shows |
| --- | --- |
| **Values** | The values *you* supplied at install/upgrade. |
| **Computed values** | The fully-merged values Helm actually used (your values + chart defaults). |
| **Manifest** | The rendered Kubernetes manifests for the release. |
| **History** | Every revision, with chart/app version, change-cause, a **Diff** and a **Roll back** button. |
| **Notes** | The release `NOTES.txt`, if the chart provides one. |

## Comparing revisions

Before rolling back — or when you're wondering what an upgrade actually changed — hit
**Diff** on any revision in the History tab. You get a side-by-side comparison against the
current revision, and you can re-pick either side to compare **any two revisions**, across
three views:

- **Values** — what *you* changed between the revisions.
- **Computed** — the fully-merged values, chart defaults included.
- **Manifest** — the rendered Kubernetes objects, the ground truth of what changed.

## Rollback & uninstall

- **Roll back** — from the History tab, return the release to any earlier revision. Helm
  records it as a new revision, so the trail stays intact.
- **Uninstall** — remove the release and all its resources. Like helm, CRDs shipped in the
  chart's `crds/` directory are left in place by default (deleting a CRD destroys every
  custom resource of that kind, cluster-wide) — but the uninstall dialog offers an opt-in
  checkbox that removes them too, listing exactly which ones.

Lifecycle hooks run the way Helm runs them: filtered per event (`pre-install`,
`post-upgrade`, `pre-delete`, …), ordered by weight, with delete policies honoured and
Job/Pod hooks awaited. Rollback and uninstall execute the hooks stored in the release
record.

!!! note "Values-only upgrades and subcharts"

    The chart stored in a release record doesn't preserve subchart dependencies, so
    upgrading a chart that declares any needs a chart source — add a repository that
    carries it (or paste its `oci://` ref) and Kubus fetches it fresh.

!!! danger "Protected clusters"

    On a [protected cluster](production-guard.md), install, upgrade, rollback and
    uninstall require you to type the release name first.

## See also

<div class="grid cards" markdown>

-   :material-file-document-edit: **[Resource details](resource-details.md)** — inspect the objects a release created
-   :material-compare: **[Comparing resources](diff.md)** — diff a release's objects across clusters

</div>
