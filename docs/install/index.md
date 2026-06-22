---
icon: lucide/download
---

# Installation

There are two ways to run Kubus. Most people want the **desktop app** — download an
installer, double-click, done. If you'd rather run it as a local web server (or you're
on a platform without a packaged build), run it **from source**.

<div class="grid cards" markdown>

-   :material-monitor: **Desktop app**

    ---

    A native window for Windows, macOS and Linux. No terminal, no Node.js — just
    install and launch. **Recommended.**

    [:octicons-arrow-right-24: Install the desktop app](desktop.md)

-   :material-console-line: **From source**

    ---

    Run the Kubus server with `pnpm` and open it in your browser. Great for
    development or headless boxes.

    [:octicons-arrow-right-24: Run from source](from-source.md)

</div>

## Before you start

Kubus drives your clusters through your existing **kubeconfig** — the same file
`kubectl` uses. You don't configure clusters inside Kubus; it reads the contexts it finds.

!!! tip "Already use `kubectl`? You're ready."

    If `kubectl get pods` works in your terminal, Kubus will find the same clusters.
    By default it reads `~/.kube/config` (or whatever `$KUBECONFIG` points at). You can
    also point it at a specific file — see [command-line flags](../reference/cli.md).

A few features lean on cluster add-ons, and degrade gracefully when they're missing:

| Feature | Needs |
| --- | --- |
| [Metrics & health charts](../guide/metrics.md) | [metrics-server](https://github.com/kubernetes-sigs/metrics-server) installed in the cluster |
| [Ephemeral debug containers](../guide/shell.md#debug-containers) | Kubernetes ≥ 1.23 |
| [File copy](../guide/copying-files.md) | `tar`, `cat` and `tee` inside the target container |

Once you're installed, head to the [Quickstart](../quickstart.md).
