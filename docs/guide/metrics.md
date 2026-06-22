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

- **Details drawer → Metrics tab** — for **Pods** and **Nodes**, live CPU/memory charts
  with the current value called out.
- **Resource lists** — CPU and memory columns on the Pods list.
- **Overview dashboard** — a per-node usage table. [More →](overview.md)

History accumulates while Kubus is open, so the first samples appear within ~20 seconds of
opening a chart and fill in from there.

## Enabling metrics-server

Metrics need the cluster add-on installed:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

On kind (and some self-managed clusters) the kubelet serves its metrics with a
self-signed cert, so metrics-server needs to skip verification:

```bash
kubectl -n kube-system patch deploy metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
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
