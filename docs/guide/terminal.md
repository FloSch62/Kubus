---
icon: lucide/terminal
---

# Terminal

The GUI and the CLI are one tool. Open a **Terminal** tab in the bottom dock and `kubectl`
is already pointed at the cluster and namespace you are looking at. No context switching,
no `--context` flags, and your real kubeconfig is never touched.

<figure markdown="span">
  ![A local terminal in the dock, pointed at the selected cluster](../assets/screenshots/terminal.png#only-light){ .shadow }
  ![A local terminal in the dock, pointed at the selected cluster](../assets/screenshots/terminal-dark.png#only-dark){ .shadow }
  <figcaption>Your own shell, with KUBECONFIG set for the cluster in view.</figcaption>
</figure>

## Opening one

- Click the **laptop icon** in the top bar.
- Press ++ctrl+grave++ / ++cmd+grave++. If a terminal is already open, this focuses it.
- Run **Open terminal here** from the command palette (++ctrl+k++ then `>`).
- Pick **Run kubectl get in terminal** from any row's ⋮ menu. The command is typed into
  the terminal and runs, so the object is on screen a second later.

The shell is your login shell (`$SHELL`, PowerShell on Windows). Change it under
[Settings → Logs & terminal](settings.md#logs-terminal).

## How it knows where you are

Each terminal session gets its own small kubeconfig file, holding exactly one context
with the namespace Kubus is filtered to, and `KUBECONFIG` points the shell at it. The
strip above the terminal shows which context and namespace that is. `KUBUS_CONTEXT` and
`KUBUS_NAMESPACE` are set as well, in case your prompt wants them.

Clusters that Kubus reaches through an [SSH jump host](clusters.md#reaching-clusters-behind-a-proxy-or-bastion)
work the same way: the session kubeconfig carries the tunnel's proxy setting, so
`kubectl` takes the same route Kubus does.

## Following the selection

A new terminal **follows** the cluster switcher and namespace filter: switch to the prod
cluster in Kubus and the next `kubectl` in the terminal already runs against prod. The
link icon in the strip shows follow mode. Pick a context or namespace from the strip's own
menus to **pin** the terminal to it instead; click the icon to follow again.

Because `kubectl` reads its kubeconfig on every run, a switch takes effect on the next
command without the shell noticing. Nothing is typed into your session.

## Requirements

A real pseudo-terminal is what makes line editing, colours, `kubectl exec -it` and
full-screen tools work. Kubus uses `node-pty` when it is installed, and falls back to
`script(1)` on Linux and macOS. Without either, the tab shows a **no tty** badge: the
shell still runs, but only for plain line-oriented commands.

!!! note "This is a shell on your machine"

    The terminal runs as you, on the computer running Kubus, with your `PATH` and
    environment. It is the same access you already have from any other terminal. The
    server only ever listens on localhost and every connection carries the session token.

## See also

<div class="grid cards" markdown>

-   :material-console: **[Shell, debug & node shell](shell.md)** are terminals *inside* the cluster.
-   :material-lightning-bolt: **[Quick actions](quick-actions.md)** cover the common `kubectl` verbs without typing.

</div>
