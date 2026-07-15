---
icon: lucide/activity
---

# Metrics & health

Kubus reads CPU and memory from **metrics-server** and keeps a short rolling history, so
you get little trend charts rather than a single instantaneous number.

<figure markdown="span">
  ![CPU and memory history charts for a pod](../assets/screenshots/metrics.png#only-light){ .shadow }
  ![CPU and memory history charts for a pod](../assets/screenshots/metrics-dark.png#only-dark){ .shadow }
  <figcaption>Live CPU/memory history right in the details drawer.</figcaption>
</figure>

## Where you'll see metrics

- **Metrics page** — the sidebar entry below Topology: cluster-wide CPU/memory trends,
  per-node lines, top pods, and a per-namespace breakdown for every selected cluster.
  If a cluster has no metrics-server yet, the page offers a one-click install instead.
- **Details drawer → Metrics tab** — for **Pods** and **Nodes**, live CPU/memory charts
  with the current value called out.
- **Resource lists** — CPU and memory columns on the Pods list.
- **Overview dashboard** — a per-node usage table. [More →](overview.md)

History accumulates while Kubus is open, so the first samples appear within ~20 seconds of
opening a chart and fill in from there.

## Installing metrics-server from Kubus

If a cluster has no metrics-server, Kubus can install it for you — no `kubectl` or
Helm required:

- On the **Overview** page, the *Node usage* card shows an **Install metrics-server**
  button whenever usage data is unavailable.
- The install dialog has one option: **Skip kubelet TLS verification**
  (`--kubelet-insecure-tls`). Enable it on local/dev clusters — kind, minikube,
  docker-desktop — whose kubelets serve self-signed certificates.

Kubus applies the official pinned `components.yaml` (Deployment, Service, RBAC and the
`metrics.k8s.io` APIService in `kube-system`) via server-side apply, and labels the
resources as managed by Kubus. Graphs appear within a minute of the pod becoming ready.
Re-running the install is safe — it re-applies the same manifest, which also repairs a
broken install.

To remove it again, use the **Uninstall** button in the Metrics page header. If the
metrics-server wasn't installed by Kubus (k3s bundles one; cloud distributions often
manage their own), Kubus warns you first — your distribution may recreate it or expect
removal through its own tooling.

Prefer the CLI? The equivalent manual install:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

!!! note "No metrics-server? No problem."

    Without it, Kubus just hides the charts and shows *"Metrics unavailable"* — every
    other feature works normally.

## Controlling refresh

Metrics, events and the overview poll on a timer. You can speed that up or dial it back
(or turn polling off) under [Settings → Data & refresh](settings.md#data-refresh).
Watched **lists** stay live over their WebSocket regardless of this setting.

## See also

<div class="grid cards" markdown>

-   :material-view-dashboard: **[Overview dashboard](overview.md)** — node usage at a glance
-   :material-bell-outline: **[Events](events.md)** — the *why* behind a spike

</div>
