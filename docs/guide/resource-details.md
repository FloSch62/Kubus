---
icon: lucide/file-text
---

# Resource details & YAML

Click any resource name and a **details drawer** slides in from the right. It gives you a
human-friendly view *and* the raw YAML, without leaving the list you're on.

<figure markdown="span">
  ![The resource details drawer for a pod](../assets/screenshots/pod-detail.png#only-light){ .shadow }
  ![The resource details drawer for a pod](../assets/screenshots/pod-detail-dark.png#only-dark){ .shadow }
  <figcaption>A readable overview up top, with tabs for YAML, events, map and metrics.</figcaption>
</figure>

## The tabs

| Tab | Shows | Available for |
| --- | --- | --- |
| **Overview** | A kind-aware summary (see below). | Every kind |
| **YAML** | A Monaco editor to read or [edit](#editing-yaml) the object. | Every kind |
| **Events** | Events involving this object, newest first, Warnings highlighted. | Every kind |
| **Map** | A focused [topology graph](topology.md) of what this object relates to. | Every kind |
| **Metrics** | Live CPU/memory [history charts](metrics.md). | Pods, Nodes |
| **History** | Rollout revisions with images and change-cause, and rollback. | Deployments, StatefulSets |

## Kind-aware overviews

The Overview tab adapts to what you're looking at:

- **Pods** — status, readiness, restarts, pod IP, QoS class, and a clickable node link;
  a containers table (images, ports, mounts, state); init and ephemeral debug containers;
  expandable env vars; volume mounts; and related ConfigMaps, Secrets and PVCs you can
  click straight through to.
- **Nodes** — roles, version, OS/arch, pod CIDR, kubelet info and allocatable resources.
- **Services** — type, cluster/external IPs, a ports table (port → targetPort → nodePort),
  the selector, and the pods behind it.
- **Secrets** — the type and data keys, with values **[redacted](production-guard.md#secrets-are-redacted-by-default)**
  until you explicitly reveal them.
- **Anything else** — metadata, owner references, labels and annotations (searchable and
  copyable), and a YAML preview of spec/status.

!!! tip "Navigate and come back"

    Click a related object — a pod's node, a referenced Secret — and the drawer follows
    it, keeping a **back stack**. Use the back arrow to return to where you were.

## Editing YAML

The **YAML** tab is a full [Monaco](https://microsoft.github.io/monaco-editor/) editor —
the same engine that powers VS Code — with syntax highlighting and folding.

1. Switch the tab to **edit** mode.
2. Make your changes.
3. **Apply** to patch the live object, or **Reset** to reload from the server.

### Conflict detection

If the object changed on the server while you were editing, Kubus won't blindly clobber
it. The apply is rejected, you're shown the conflict, the view refreshes to the latest
state, and you can re-apply your change against it. No silent overwrites.

!!! warning "Edits are real"

    Applying YAML patches the live resource immediately. On a
    [protected cluster](production-guard.md), destructive edits are gated behind a typed
    confirmation — but there's no undo for a normal edit beyond editing again.

## Creating resources

You don't need an existing object to use the editor — Kubus can open a blank YAML buffer
so you can paste or write a manifest and apply it to create the resource, the same way
`kubectl apply -f` would.

## See also

<div class="grid cards" markdown>

-   :material-lightning-bolt: **[Quick actions](quick-actions.md)** — scale, restart and more without editing YAML
-   :material-compare: **[Comparing resources](diff.md)** — diff two objects side by side
-   :material-graph-outline: **[Topology](topology.md)** — the Map tab, full-screen

</div>
