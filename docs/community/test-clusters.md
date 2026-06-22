---
icon: lucide/flask-conical
---

# Test clusters

The repo ships a script that spins up two [kind](https://kind.sigs.k8s.io/) clusters
loaded with sample workloads — perfect for exploring or developing against without
touching anything real.

## What it sets up

`hack/dev-clusters.sh` creates:

- **`kind-kubus-a`** — the full demo:
    - [metrics-server](https://github.com/kubernetes-sigs/metrics-server) (patched for
      kind's self-signed kubelet certs), so the [metrics](../guide/metrics.md) and
      [overview](../guide/overview.md) charts light up;
    - a **`podinfo`** Helm release with 3 replicas — great for
      [aggregated logs](../guide/logs.md) and [Helm](../guide/helm.md);
    - intentionally **broken workloads** (crash-loops, bad images, a failing Deployment, a
      CronJob) so the [overview dashboard](../guide/overview.md) has something to flag.
- **`kind-kubus-b`** — an empty cluster, so you can try the
  [multi-cluster](../guide/clusters.md) merged views and the cluster column.

## Prerequisites

- [`kind`](https://kind.sigs.k8s.io/docs/user/quick-start/#installation)
- [`kubectl`](https://kubernetes.io/docs/tasks/tools/)
- [`helm`](https://helm.sh/docs/intro/install/)
- A working container runtime (Docker)

## Run it

```bash
./hack/dev-clusters.sh
```

Then launch Kubus and select the **`kind-kubus-a`** and **`kind-kubus-b`** contexts in the
[cluster switcher](../guide/clusters.md).

!!! warning "kind + inotify limits"

    On Linux, low inotify limits make kind's system pods crash-loop with *"too many open
    files"*. If you hit that, raise them:

    ```bash
    sudo sysctl fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288
    ```

## Tear down

```bash
kind delete cluster --name kubus-a
kind delete cluster --name kubus-b
```

## See also

<div class="grid cards" markdown>

-   :material-rocket-launch: **[Quickstart](../quickstart.md)** — follow along against these clusters
-   :material-code: **[Building from source](development.md)** — the rest of the dev setup

</div>
