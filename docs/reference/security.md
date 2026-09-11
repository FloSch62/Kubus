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
  credentials. There is no Kubus cloud, no account, and no telemetry. Data only moves
  between your machine and the clusters you point it at.

## Per-run access token

Even on localhost, other web pages in your browser could try to reach the server. To stop
that, every run mints a fresh random **bearer token**:

- 24 random bytes, base64url-encoded.
- Delivered to the browser in the launch URL (`…/?token=…`).
- Required on **every** API and WebSocket request.

This defends against **DNS-rebinding** and **CSRF** attacks that target local servers. The
token isn't persisted; restart Kubus and a new one is generated.

## Secrets are redacted by default

Secret values are hidden everywhere: in lists, in details, and in the live watch streams
that back them. They are only revealed when you explicitly ask, per resource. There is
no global "reveal all" toggle to leave on by accident. See
[Production guard & secrets](../guide/production-guard.md).

## The production guard is a guard, not a wall

You can mark clusters as **protected** so destructive actions require typing the resource
name first. This is a safety net against slips.

!!! warning "It is not an authorization boundary"

    The production guard runs in the browser UI. It does **not** restrict what the server
    (and therefore anyone with your kubeconfig) can do. For actual access control, use
    **Kubernetes RBAC** and scope the credentials in your kubeconfig to what each cluster
    should allow.

## What Kubus can do is what your kubeconfig can do

Kubus has exactly the permissions your kubeconfig grants. If you want a read-only
experience, point it at a kubeconfig with read-only RBAC. If a context can delete
namespaces, so can Kubus (behind the guard, if protected).

## Code signing

macOS releases are signed with Apple Developer ID and notarized, and target Apple
Silicon. Windows NSIS releases currently remain unsigned; the release pipeline can
also enforce certificate, Azure or custom signing. See [Desktop app](../install/desktop.md)
and [Releasing](../community/releasing.md).

The desktop updater downloads from GitHub Releases over HTTPS and verifies payload
hashes. macOS additionally validates the app signature; signed Windows installations
validate the configured publisher. Hashes alone do not authenticate an unsigned
Windows publisher. Store packages use Store-managed updates, and Debian packages
are updated through the package manager. Updates never include cluster data in
requests and never restart Kubus while you are working without your action.

## See also

<div class="grid cards" markdown>

-   :material-sitemap: **[Architecture](architecture.md)** shows where the trust boundaries sit.
-   :material-shield-alert: **[Production guard & secrets](../guide/production-guard.md)** covers the UI guard rails.

</div>
