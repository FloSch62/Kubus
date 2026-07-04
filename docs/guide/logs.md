---
icon: lucide/scroll-text
---

# Logs

Kubus streams logs into the **bottom dock**, and it can aggregate many pods into one
view — so a Deployment's logs read as a single, colour-coded stream instead of a dozen
separate `kubectl logs -f` windows.

<figure markdown="span">
  ![The aggregated log viewer](../assets/screenshots/logs.png#only-light){ .shadow }
  ![The aggregated log viewer](../assets/screenshots/logs-dark.png#only-dark){ .shadow }
  <figcaption>Logs from every pod of a workload, each pod in its own colour.</figcaption>
</figure>

## Opening logs

- **A pod** — ⋮ menu → **Logs**.
- **A workload** (Deployment, ReplicaSet, StatefulSet, DaemonSet) — ⋮ menu → **Logs**
  aggregates every matching pod into one stream.
- **A Service** — ⋮ menu → **Logs** follows the pods behind it.
- **From the palette** — ++ctrl+k++, find the resource, ++tab++ → **Logs**.

Each stream opens as its own **tab** in the dock, so you can watch several at once.

## Time range

Pick how far back to read, from the toolbar:

| Mode | Behaviour |
| --- | --- |
| **Live tail** | Follows new lines as they arrive (the default). |
| **10m / 1h / 6h / 24h ago** | Loads logs since that point, no follow. |
| **Terminated** | The **previous** container's logs — what a crash-looping pod said before it died. |

!!! tip "Debugging a crash loop"

    Use **Terminated** to read the logs from the last run of a container that keeps
    restarting — the most useful logs are usually the ones from just before it exited.

## Make sense of the stream

- **Per-pod colour** — every pod gets a distinct colour, so you can tell who said what in
  an aggregated stream.
- **Log levels** — Kubus detects each line's severity (JSON, logfmt, klog and plain
  formats) and shows **E / W / I / D / T count chips** in the toolbar. Click a chip to
  keep only that level — combine several, and error/warning lines get a subtle tint so
  they stand out while scrolling.
- **Regex filter** — type a pattern to keep only matching lines.
- **Follow** — toggle live following on or off (e.g. to scroll back without the view jumping).
- **Wrap** — wrap long lines instead of scrolling sideways.
- **Timestamps** — off, local time, or UTC.
- **Syntax highlighting** — Kubus recognises JSON and logfmt and highlights levels
  (`error`, `warn`, …) so problems stand out.

Defaults for tail length, wrapping, timestamps and highlighting live in
[Settings → Logs & terminal](settings.md#logs-terminal).

## Export

- **Download** the current buffer as a text file.
- **Copy** it to the clipboard.
- **Clear** the on-screen buffer to start fresh.
- **Maximise** the dock when you need room to read.

## See also

<div class="grid cards" markdown>

-   :material-console: **[Shell & debug](shell.md)** — when reading logs isn't enough
-   :material-cog: **[Settings](settings.md#logs-terminal)** — change the log defaults

</div>
