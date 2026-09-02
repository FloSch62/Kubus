---
icon: lucide/help-circle
---

# FAQ

### Is Kubus free?

Yes. Kubus is free and open source under the MIT license.

### Does my cluster data leave my machine?

No. The server runs locally, binds to `127.0.0.1`, and talks to your clusters with your
own kubeconfig. There's no Kubus cloud and no telemetry. See the
[security model](../reference/security.md).

### Do I need to install anything in my cluster?

No. Kubus works against any cluster your kubeconfig can reach. A couple of features are
nicer with add-ons, such as [metrics-server](../guide/metrics.md) for CPU/memory charts,
but everything degrades gracefully without them.

### Does it work with my managed cluster (EKS / GKE / AKS / k3s / …)?

If `kubectl` can talk to it, so can Kubus. It uses the same kubeconfig and credential
plugins. A 401 or 403 from a cloud cluster almost always comes from the credential plugin
or the cloud login itself. See
[Cloud-managed clusters](../guide/clusters.md#cloud-managed-clusters-gke-eks-aks).

### Will it show my CustomResourceDefinitions?

Yes. CRDs are picked up automatically, printer columns included. See
[Browsing resources](../guide/browsing-resources.md#custom-resources-first-class).

### Can it manage Helm releases without the `helm` binary?

Yes. The server decodes Helm's release records itself and renders charts with Helm's own
engine compiled to WebAssembly, so the full lifecycle works, hooks included. See
[Helm releases](../guide/helm.md).

### How do I stop myself nuking production?

Mark the cluster as **protected**. Destructive actions then require typing the resource
name. It's a UI guard, not RBAC. See [Production guard](../guide/production-guard.md).

### Why does macOS say the app is damaged / unverified?

The builds aren't notarised yet. Right-click → **Open**, or run
`xattr -d com.apple.quarantine /Applications/Kubus.app`. Details on the
[Desktop app](../install/desktop.md) page.

### Can I run it on a remote/headless box?

You can run the server [from source](../install/from-source.md), but it binds to
`127.0.0.1` by design. Kubus is built to be a local tool, so reach it over an SSH tunnel
rather than exposing it.

### Which port does it use?

`3001` by default; change it with `--port` or `$PORT`. See
[command-line flags](../reference/cli.md).

### How do I update?

Desktop: install the newer release over the top. From source: `git pull && pnpm install &&
pnpm build`.

### Something's missing or broken: where do I report it?

Open an issue on [GitHub](https://github.com/FloSch62/Kubus). See
[Contributing](contributing.md).
