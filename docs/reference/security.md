---
icon: lucide/shield-check
---

# Security model

Kubus is a **local** tool. It runs on your machine, uses credentials you already have, and
is built so that nothing leaves your laptop. This page spells out exactly what that means.

## Local-only by design

- The server binds to **`127.0.0.1`** and nothing else. Other machines on your network
  can't reach it.
- It talks to your cluster API servers **directly**, using your existing **kubeconfig**
  credentials. There is no Kubus cloud, no account, and no telemetry — no data is sent
  anywhere except between your machine and the clusters you point it at.

## Per-run access token

Even on localhost, other web pages in your browser could try to reach the server. To stop
that, every run mints a fresh random **bearer token**:

- 24 random bytes, base64url-encoded.
- Delivered to the browser in the launch URL (`…/?token=…`).
- Required on **every** API and WebSocket request.

This defends against **DNS-rebinding** and **CSRF** attacks that target local servers. The
token isn't persisted; restart Kubus and a new one is generated.

## Secrets are redacted by default

Secret values are hidden **everywhere** — lists, details, and the live watch streams that
back them — and only revealed when you explicitly ask, per resource. There is no global
"reveal all" toggle to leave on by accident. See
[Production guard & secrets](../guide/production-guard.md).

## The production guard is a guard, not a wall

You can mark clusters as **protected** so destructive actions require typing the resource
name first. This is a safety net against slips.

!!! warning "It is not an authorization boundary"

    The production guard runs in the browser UI. It does **not** restrict what the server
    (and therefore anyone with your kubeconfig) can do. For actual access control, use
    **Kubernetes RBAC** — scope the credentials in your kubeconfig to what each cluster
    should allow.

## What Kubus can do is what your kubeconfig can do

Kubus has exactly the permissions your kubeconfig grants — no more, no less. If you want a
read-only experience, point it at a kubeconfig with read-only RBAC. If a context can
delete namespaces, so can Kubus (behind the guard, if protected).

## Code signing

Desktop builds aren't code-signed or notarised yet, which is why the first launch needs an
extra step on macOS and Windows. See [Desktop app](../install/desktop.md). If you'd rather
not run unsigned binaries, [build from source](../install/from-source.md).

## See also

<div class="grid cards" markdown>

-   :material-sitemap: **[Architecture](architecture.md)** — where the trust boundaries sit
-   :material-shield-alert: **[Production guard & secrets](../guide/production-guard.md)** — the UI guard rails

</div>
