---
icon: lucide/cable
---

# Port forwarding

Reach a pod or service on your laptop as if it were local — no `kubectl port-forward`
window to babysit. Kubus manages forwards centrally and shows them all on one page.

<figure markdown="span">
  ![The Port Forwards page](../assets/screenshots/port-forwards.png#only-light){ .shadow }
  ![The Port Forwards page](../assets/screenshots/port-forwards-dark.png#only-dark){ .shadow }
  <figcaption>Every active forward in one place — click the local URL to open it.</figcaption>
</figure>

## Starting a forward

- **Pod** or **Service** ⋮ menu → **Port forward…**

In the dialog:

- **Remote port** — defaults to the resource's first port (or `80`).
- **Local port** — leave blank to have one auto-assigned, or pin a specific one.

For a **Service**, Kubus resolves the service port to the backing pod's `targetPort`, just
like `kubectl` does — so you forward to the port that actually serves traffic.

## Managing forwards

The **Port Forwards** page (in the nav, or ++ctrl+k++ → *Go to Port Forwards*) lists every
active forward with its:

- **Local** address — a clickable `http://localhost:<port>` link,
- **Target** and **Pod**,
- **Cluster**,
- **State** (active / error) and connection count,
- a **Stop** button.

!!! note "Forwards live with the server"

    A forward stays up as long as the Kubus server process is running. Closing the
    browser tab doesn't drop it — stop it explicitly from the Port Forwards page.

## See also

<div class="grid cards" markdown>

-   :material-file-tree: **[Copying files](copying-files.md)** — get files in and out of a pod
-   :material-console: **[Shell & debug](shell.md)** — a terminal into the container instead

</div>
