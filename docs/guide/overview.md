---
icon: lucide/layout-dashboard
---

# Overview dashboard

The **Overview** is the first thing you see, and the fastest way to answer "is anything
on fire?" It summarises the health of every selected cluster on one screen.

<figure markdown="span">
  ![The Overview dashboard](../assets/screenshots/overview.png#only-light){ .shadow }
  ![The Overview dashboard](../assets/screenshots/overview-dark.png#only-dark){ .shadow }
  <figcaption>One card stack per cluster, showing counts, usage and what's broken.</figcaption>
</figure>

## What each cluster card shows

For every selected cluster you get:

- **Counts**: nodes, namespaces, pods (running / total) and deployments.
- **Failing pods**: anything not Running/Ready, such as crash-loops, image-pull errors or
  pending pods.
- **Warnings (last hour)**: a rollup of recent `Warning` events.
- **Node usage**: a CPU/memory table when [metrics-server](metrics.md) is available.

The failing-pods and warnings panels are **lists you can click**: selecting an entry jumps
you straight to that pod or to the [Events](events.md) page, filtered to the problem.

## Scoped to a namespace

Pick one or more namespaces in the [namespace filter](clusters.md#filtering-by-namespace)
and a cluster's card turns into a `kubectl get all -n` for those namespaces, and more:

- **Inventory**: one tile per kind with objects in it, including the popular custom
  resources you have installed (cert-manager, Argo, Flux, KEDA, Gateway API routes and
  others). Kinds with a notion of health get a bar split into healthy (green), degraded
  (amber) and failed (red), with the failed and degraded counts spelled out underneath.
  Empty kinds are listed on one line below the tiles.
- **Workload health**, operator rollups, expiring certificates, **resource quotas** as
  usage bars, pod usage against requests and limits, failing pods and warning events.

Every tile opens that kind's list. The list keeps the same namespace filter, so you land
on exactly the objects the tile counted.

What counts as degraded or failed:

| Kind | Degraded | Failed |
| --- | --- | --- |
| Pods | Not ready yet, or Pending for under five minutes | Crash-looping, image pull errors, Failed, or Pending for longer |
| Deployments, StatefulSets, DaemonSets, ReplicaSets | Some replicas unavailable | No replica available |
| Jobs, CronJobs | | The Job, or the CronJob's latest run, failed |
| PersistentVolumeClaims | Not bound yet | Lost |
| ResourceQuotas | A resource at 90% or more | A resource at its hard limit |
| HorizontalPodAutoscalers, PodDisruptionBudgets | Cannot scale, or blocks every eviction | |
| Custom resources | `Ready` still unknown, Argo sync drift or a progressing rollout | `Ready` is `False`, Argo health degraded, or a route a gateway rejected |

The same inventory, with its bars, heads the Overview tab of a **Namespace** in the
[details drawer](resource-details.md), so opening a namespace from the Namespaces list
shows what lives inside it.

## Reading the signals

| You see… | It usually means… |
| --- | --- |
| Failing pods with `ImagePullBackOff` / `ErrImagePull` | A bad image reference or missing pull secret. |
| Failing pods with `CrashLoopBackOff` | The container keeps exiting. Check its [logs](logs.md). |
| `Pending` pods | Nothing can schedule them. Check node capacity or taints. |
| Warnings climbing | Look at the events timeline for the reason and the involved object. |

!!! tip "Multi-cluster triage"

    With several clusters selected, the Overview becomes a single pane of glass. Scan the
    cards top to bottom; the one with red numbers is where to start.

## No metrics yet?

If the node-usage table says metrics are unavailable, install metrics-server:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

On kind and some managed clusters you also need the `--kubelet-insecure-tls` flag. See
[Metrics & health](metrics.md) for details.

## See also

<div class="grid cards" markdown>

-   :material-bell-outline: **[Events](events.md)** has the full, filterable timeline behind the warnings count.
-   :material-chart-areaspline: **[Metrics & health](metrics.md)** has per-pod and per-node history charts.

</div>
