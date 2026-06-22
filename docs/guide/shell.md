---
icon: lucide/square-terminal
---

# Shell, debug & node shell

When logs aren't enough, get a real terminal. Kubus gives you three kinds of shell, each
opening as a tab in the [bottom dock](the-window.md#bottom-dock) — a full
[xterm.js](https://xtermjs.org/) terminal with colours, cursor control and automatic
resize.

<figure markdown="span">
  ![A container shell open in the dock](../assets/screenshots/shell.png#only-light){ .shadow }
  ![A container shell open in the dock](../assets/screenshots/shell-dark.png#only-dark){ .shadow }
  <figcaption>A genuine interactive terminal, straight into a container.</figcaption>
</figure>

## Container shell

Open a shell into any container:

- **Pod** ⋮ menu → **Shell**, or ++ctrl+k++ → find the pod → ++tab++ → **Shell**.

Kubus runs the Kubernetes `exec` API over a WebSocket. By default it tries **`bash`** and
falls back to **`sh`**, so it works on minimal images too. The terminal resizes with the
pane, and the session ends cleanly when you close the tab.

You can change the default shell (or set a custom path) in
[Settings → Logs & terminal](settings.md#logs-terminal).

## Debug containers

Some images have no shell at all — distroless, scratch, a stripped Go binary. For those,
attach an **ephemeral debug container**:

- **Pod** ⋮ menu → **Debug container…**

1. Choose a debug **image** (default `busybox:1.36`).
2. Optionally pick a **target container** to share a process namespace with, so you can
   see and poke at its processes.
3. Kubus attaches the ephemeral container and drops you into a shell inside it — the same
   idea as `kubectl debug`.

!!! note "Requirements & lifetime"

    Ephemeral containers need **Kubernetes ≥ 1.23**. Once added, a debug container stays
    in the pod's spec until the pod is recreated.

## Node shell

Need to get onto the host itself — check `dmesg`, inspect `/var/log`, run `crictl`? The
**node shell** launches a temporary **privileged** pod and `nsenter`s into the node's root
namespace, giving you a root shell on the machine.

- **Node** ⋮ menu → **Node shell…**

<figure markdown="span">
  ![A node shell session](../assets/screenshots/shell.png#only-light){ .shadow }
  ![A node shell session](../assets/screenshots/shell-dark.png#only-dark){ .shadow }
  <figcaption>A root shell on the node, via a privileged helper pod.</figcaption>
</figure>

!!! danger "This is powerful — and it knows it"

    The node shell runs a **privileged** pod with host PID, network and IPC. Kubus warns
    you before starting one, and on a [protected cluster](production-guard.md) you must
    type the node name to confirm. The helper pod is **deleted when you close the
    terminal**.

## See also

<div class="grid cards" markdown>

-   :material-file-tree: **[Copying files](copying-files.md)** — move files in and out of containers
-   :material-script-text: **[Logs](logs.md)** — the lighter-weight first look

</div>
