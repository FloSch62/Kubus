---
icon: lucide/server
---

# Connecting clusters

Kubus works with the kubeconfig you already have — it reads the same contexts `kubectl`
would, and you pick which ones to look at. When you need to, you can also **add** and
**edit** clusters from inside the app, including the settings that let you reach a cluster
through a bastion or proxy.

## Selecting contexts

Click the **cluster switcher** in the top bar and tick the contexts you want active. You
can select **as many as you like** — Kubus talks to all of them at once.

<figure markdown="span">
  ![The cluster switcher with several contexts selected](../assets/screenshots/cluster-switcher.png#only-light){ .shadow }
  ![The cluster switcher with several contexts selected](../assets/screenshots/cluster-switcher-dark.png#only-dark){ .shadow }
  <figcaption>Every context from your kubeconfig, ready to select.</figcaption>
</figure>

Your selection is remembered between sessions. To point Kubus at a *different* kubeconfig
file entirely, launch it with `--kubeconfig` or set `KUBECONFIG` — see
[command-line flags](../reference/cli.md).

## Working across many clusters

This is where Kubus earns its keep. When two or more clusters are selected:

- **Lists merge.** A single Pods list shows pods from every selected cluster.
- **A Cluster column appears**, so you always know where a row lives.
- **Search, events and the overview** all span every selected cluster.
- **Actions stay scoped.** Deleting, scaling or restarting always targets the specific
  cluster the resource belongs to — there's no accidental fan-out.

<figure markdown="span">
  ![A merged Pods list with a cluster column](../assets/screenshots/pods.png#only-light){ .shadow }
  ![A merged Pods list with a cluster column](../assets/screenshots/pods-dark.png#only-dark){ .shadow }
  <figcaption>One list, many clusters — the Cluster column keeps things clear.</figcaption>
</figure>

!!! tip "Compare the same thing across clusters"

    Looking at a ConfigMap that's supposed to be identical in staging and prod? The
    [Diff page](diff.md) puts two resources from any two clusters side by side.

## Filtering by namespace

The **namespace filter** next to the cluster switcher narrows every list to the
namespaces you choose. Leave it empty to see all namespaces.

The filter applies **across all selected clusters** — handy when the same namespace
(say, `ingress-nginx`) exists in several of them. Clusters that don't have a matching
namespace simply contribute nothing to the list.

## Adding & editing clusters

Open **Settings → Clusters** to manage the entries in your kubeconfig:

- **Add cluster** — paste a kubeconfig snippet, or fill in a short form (name, API server,
  CA, and either a bearer token or a client certificate). It's merged into your kubeconfig,
  and a backup is written first.
- **Edit** (:material-pencil: on any row) — change a cluster's **API server**,
  **credentials**, TLS settings, and the proxy options below. Cloud-provider clusters that
  authenticate with an exec plugin (EKS/GKE/AKS) keep their existing login — leave
  **Credentials** on *Keep current* and only the other fields change.

Every change is written straight to your kubeconfig file (with a `.kubus.bak` backup), so
`kubectl` and other tools see the same settings.

## Reaching clusters behind a proxy or bastion

If a cluster's API server isn't directly reachable from your machine — only through a
bastion, VPN, or SSH jump host — open its **Edit** dialog and use the two fields under
*"Only if this cluster isn't reachable directly"*:

| Field | What it does | Typical value |
| --- | --- | --- |
| **Proxy** | Sends this cluster's traffic through a SOCKS or HTTP proxy. | `socks5://localhost:1080` |
| **Certificate hostname** | The hostname to expect on the server's TLS certificate — set it when the API server address is an IP or tunnel that doesn't match the certificate. | `api.prod.example.com` |

!!! tip "SOCKS over an SSH jump is the easy path"

    Run `ssh -D 1080 bastion` to open a SOCKS proxy, then set **Proxy** to
    `socks5://localhost:1080`. Because SOCKS keeps the original hostname, TLS verification
    just works — no certificate hostname needed. Prefer this over an `ssh -L` port-forward,
    which points the server at `localhost` and then *does* need a **Certificate hostname**.

Both fields map to standard kubeconfig keys (`proxy-url` and `tls-server-name`), so they
work with `kubectl` too. **Test connection** in the dialog tells you immediately whether
the settings work.

!!! note "Already using a proxy environment variable?"

    Kubus also honors `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` from the environment it's
    launched in. A cluster reached that way shows an **env proxy** tag; saving a proxy in
    the Edit dialog writes it into the kubeconfig and takes over.

## Protecting risky clusters

Some clusters you'd rather not fat-finger. Mark a cluster as **protected** and Kubus
requires you to type the resource name before any destructive action (delete, scale to
zero, drain…). See [Production guard & secrets](production-guard.md).

## See also

<div class="grid cards" markdown>

-   :material-view-dashboard: **[Overview dashboard](overview.md)** — health across every selected cluster
-   :material-cog: **[Settings → Clusters](settings.md)** — manage kubeconfig entries and protection

</div>
