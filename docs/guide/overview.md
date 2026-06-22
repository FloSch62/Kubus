---
icon: lucide/layout-dashboard
---

# Overview dashboard

The **Overview** is the first thing you see, and the fastest way to answer "is anything
on fire?" It summarises the health of every selected cluster on one screen.

<figure markdown="span">
  ![The Overview dashboard](../assets/screenshots/overview.png#only-light){ .shadow }
  ![The Overview dashboard](../assets/screenshots/overview-dark.png#only-dark){ .shadow }
  <figcaption>One card stack per cluster — counts, usage, and what's broken.</figcaption>
</figure>

## What each cluster card shows

For every selected cluster you get:

- **Counts** — nodes, namespaces, pods (running / total), and deployments.
- **Failing pods** — anything not Running/Ready: crash-loops, image-pull errors, pending.
- **Warnings (last hour)** — a rollup of recent `Warning` events.
- **Node usage** — a CPU/memory table when [metrics-server](metrics.md) is available.

The failing-pods and warnings panels are **lists you can click**: selecting an entry jumps
you straight to that pod or to the [Events](events.md) page, filtered to the problem.

## Reading the signals

| You see… | It usually means… |
| --- | --- |
| Failing pods with `ImagePullBackOff` / `ErrImagePull` | A bad image reference or missing pull secret. |
| Failing pods with `CrashLoopBackOff` | The container keeps exiting — check its [logs](logs.md). |
| `Pending` pods | Nothing can schedule them — check node capacity or taints. |
| Warnings climbing | Look at the events timeline for the reason and the involved object. |

!!! tip "Multi-cluster triage"

    With several clusters selected, the Overview becomes a single pane of glass. Scan the
    cards top to bottom; the one with red numbers is where to start.

## No metrics yet?

If the node-usage table says metrics are unavailable, install metrics-server:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

On kind and some managed clusters you also need the `--kubelet-insecure-tls` flag — see
[Metrics & health](metrics.md) for details.

## See also

<div class="grid cards" markdown>

-   :material-bell-outline: **[Events](events.md)** — the full, filterable timeline behind the warnings count
-   :material-chart-areaspline: **[Metrics & health](metrics.md)** — per-pod and per-node history charts

</div>
