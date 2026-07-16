---
icon: lucide/network
---

# Network metrics

Kubus can show **live traffic between your pods** — who talks to whom, at what rate —
without Prometheus, a service mesh, or a specific CNI.

<figure markdown="span">
  ![Cluster traffic, top pods and busiest links](../assets/screenshots/network-metrics.png#only-light){ .shadow }
  ![Cluster traffic, top pods and busiest links](../assets/screenshots/network-metrics-dark.png#only-dark){ .shadow }
  <figcaption>Live pod-to-pod traffic — no Prometheus or service mesh required.</figcaption>
</figure>

The data comes from [Microsoft Retina](https://github.com/microsoft/retina) (open
source, Apache-2.0), an eBPF network-observability agent that Kubus deploys on demand.
Kubus scrapes each agent through the Kubernetes API-server pod proxy, so no extra
network paths or credentials are involved — if your kubeconfig can reach the cluster,
the traffic view works. Retina attributes traffic by IP, so it also works on local
clusters like kind.

## What the page shows

The **Network Metrics** sidebar entry (below Metrics) renders, per selected cluster:

- **Tiles** — cluster-wide throughput, active traffic links, pods with traffic, and
  how many node agents are reporting.
- **Cluster traffic** — a rolling ~30-minute throughput trend (each flow counted once).
- **Top pods by traffic** — the busiest pods, sent + received stacked.
- **Busiest links** — a table of endpoint pairs with per-second rates in each
  direction, plus TCP retransmissions and dropped bytes when they occur. Endpoints
  are shown as pods where Retina resolved them; other IPs resolve to Services
  (ClusterIP), nodes, or show as the raw IP.

Links are **direction-neutral** — the agent observes packets, not who opened the
connection — so each link shows A→B and B→A rates. Rates are computed between agent
scrapes (~20 s apart), and history accumulates while Kubus is open.

## Installing the network agent

If the agent isn't installed, the page offers a one-click install instead. Kubus
applies a pinned, vendored render of the upstream Retina chart via server-side apply
into **kube-system** (the same namespace Retina's own chart uses): the eBPF agent
DaemonSet, a small operator Deployment, two `retina.sh` CRDs and their RBAC — all
labeled as managed by Kubus. Re-running the install is safe — it re-applies the same
manifest, which also repairs a broken install.

A few things to know before installing:

- The agent pods use the **host network and elevated capabilities** (with a
  privileged init container) — that's what eBPF needs. Linux nodes only.
- Retina's pod-level metrics require an explicit namespace list
  (`MetricsConfiguration` CRD). Kubus creates it for all namespaces and keeps it in
  sync automatically as namespaces come and go.
- Expect roughly 500m CPU / 300 Mi memory requested per node (upstream defaults).

To remove it again, use the **Uninstall** button in the page header — it deletes
everything the install created. If the Retina install wasn't created by Kubus (AKS
add-ons, your own Helm release), a warning notes that it may be managed elsewhere.
