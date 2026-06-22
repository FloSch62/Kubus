---
icon: lucide/shield-alert
---

# Production guard & secrets

Kubus is built to be safe to point at real clusters. Two features do most of that work:
the **production guard** for destructive actions, and **secret redaction** for sensitive
data.

## The production guard

Mark a cluster as **protected** and Kubus inserts a deliberate speed bump in front of
anything destructive: you must **type the resource's name** to confirm.

<figure markdown="span">
  ![A type-to-confirm dialog on a protected cluster](../assets/screenshots/production-guard.png#only-light){ .shadow }
  ![A type-to-confirm dialog on a protected cluster](../assets/screenshots/production-guard-dark.png#only-dark){ .shadow }
  <figcaption>On a protected cluster, you type the name before anything dangerous happens.</figcaption>
</figure>

### What it gates

- **Delete** anything
- **Scale to zero** (taking a workload to no replicas)
- **Drain** and **cordon** a node
- **Node shell** (a privileged pod on the host)
- **Restart pods**, Helm **rollback** and **uninstall**

Non-destructive actions stay one click away — the guard only stands in front of the things
you can't undo.

### Turning it on

In [Settings → Clusters](settings.md), toggle protection per cluster. You can also set
**protect by default**, so every cluster is guarded unless you explicitly mark it safe —
a good default if you mostly work against production.

!!! warning "A guard, not a wall"

    The production guard lives in **this browser's UI**. It protects against slips and
    fat-fingers — it is **not** a server-side permission boundary. Anyone with your
    kubeconfig still has whatever access it grants. For real authorization, use
    **Kubernetes RBAC**.

## Secrets are redacted by default

Kubus never shows Secret data unless you ask. Values are redacted **everywhere** — in
lists, in details, and in the live watch streams that back them — and shown as `••••`.

To see a value, open the Secret's [details drawer](resource-details.md) and **reveal** it
explicitly. Revealing is a deliberate, per-resource action — there's no global "show all
secrets" switch to leave on by accident.

!!! tip "Safe to screen-share"

    Because redaction is the default and reveal is explicit, you can demo Kubus or share
    your screen without a Secret value flashing past.

## See also

<div class="grid cards" markdown>

-   :material-shield-lock: **[Security model](../reference/security.md)** — how Kubus stays local and authenticated
-   :material-cog: **[Settings](settings.md)** — where to toggle protection

</div>
