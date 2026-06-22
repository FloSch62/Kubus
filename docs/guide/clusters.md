---
icon: lucide/server
---

# Connecting clusters

Kubus works with the kubeconfig you already have. There's nothing to configure inside the
app — it reads the contexts `kubectl` would, and you pick which ones to look at.

## Selecting contexts

Click the **cluster switcher** in the top bar and tick the contexts you want active. You
can select **as many as you like** — Kubus talks to all of them at once.

<figure markdown="span">
  ![The cluster switcher with several contexts selected](../assets/screenshots/cluster-switcher.png#only-light){ .shadow }
  ![The cluster switcher with several contexts selected](../assets/screenshots/cluster-switcher-dark.png#only-dark){ .shadow }
  <figcaption>Every context from your kubeconfig, ready to select.</figcaption>
</figure>

Your selection is remembered between sessions. To point Kubus at a *different* kubeconfig
file entirely, launch it with `--kubeconfig` or set `KUBECONFIG` — see
[command-line flags](../reference/cli.md).

## Working across many clusters

This is where Kubus earns its keep. When two or more clusters are selected:

- **Lists merge.** A single Pods list shows pods from every selected cluster.
- **A Cluster column appears**, so you always know where a row lives.
- **Search, events and the overview** all span every selected cluster.
- **Actions stay scoped.** Deleting, scaling or restarting always targets the specific
  cluster the resource belongs to — there's no accidental fan-out.

<figure markdown="span">
  ![A merged Pods list with a cluster column](../assets/screenshots/pods.png#only-light){ .shadow }
  ![A merged Pods list with a cluster column](../assets/screenshots/pods-dark.png#only-dark){ .shadow }
  <figcaption>One list, many clusters — the Cluster column keeps things clear.</figcaption>
</figure>

!!! tip "Compare the same thing across clusters"

    Looking at a ConfigMap that's supposed to be identical in staging and prod? The
    [Diff page](diff.md) puts two resources from any two clusters side by side.

## Filtering by namespace

The **namespace filter** next to the cluster switcher narrows every list to the
namespaces you choose. Leave it empty to see all namespaces.

The filter applies **across all selected clusters** — handy when the same namespace
(say, `ingress-nginx`) exists in several of them. Clusters that don't have a matching
namespace simply contribute nothing to the list.

## Protecting risky clusters

Some clusters you'd rather not fat-finger. Mark a cluster as **protected** and Kubus
requires you to type the resource name before any destructive action (delete, scale to
zero, drain…). See [Production guard & secrets](production-guard.md).

## See also

<div class="grid cards" markdown>

-   :material-view-dashboard: **[Overview dashboard](overview.md)** — health across every selected cluster
-   :material-cog: **[Settings → Clusters](settings.md)** — manage kubeconfig entries and protection

</div>
