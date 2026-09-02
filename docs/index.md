---
icon: lucide/house
hero: true
hide:
  - navigation
  - toc
---

![The Kubus overview dashboard](assets/screenshots/overview.png#only-light){ .shadow .kubus-shot }
![The Kubus overview dashboard](assets/screenshots/overview-dark.png#only-dark){ .shadow .kubus-shot }

## Where Kubus fits

`kubectl` is fast, but it shows you one thing at a time and you have to know what to ask
for. Dashboards give you a picture, but they live inside a cluster and need RBAC, an ingress
and a login before you see anything. Kubus is a desktop app instead. It reads the kubeconfig
you already have, connects to as many clusters as you select, and keeps everything on your
machine.

<div class="grid cards" markdown>

-   :material-kubernetes: **Every cluster at once**

    ---

    Select any number of kubeconfig contexts. Lists merge into one view with a
    cluster column, so you stop switching contexts to compare things.

    [:octicons-arrow-right-24: Connecting clusters](guide/clusters.md)

-   :material-cube-outline: **Every resource kind**

    ---

    Built-in workloads, networking, config, storage and RBAC, plus every CRD in the
    cluster. CRDs are discovered live and their printer columns become real columns.

    [:octicons-arrow-right-24: Browsing resources](guide/browsing-resources.md)

-   :material-script-text-outline: **Aggregated logs**

    ---

    Stream logs from many pods at once, colour-coded per pod. Filter with a regex,
    follow the tail, show timestamps, read the previous container and download the lot.

    [:octicons-arrow-right-24: Logs](guide/logs.md)

-   :material-console: **Shells & debugging**

    ---

    A real terminal into any container, ephemeral debug containers for distroless
    pods, and a privileged node shell that runs `nsenter` on the host.

    [:octicons-arrow-right-24: Shell & debug](guide/shell.md)

-   :material-chart-areaspline: **Metrics & health**

    ---

    CPU and memory history from metrics-server, and an overview dashboard that
    flags failing pods, unavailable workloads, restarts and warnings.

    [:octicons-arrow-right-24: Metrics & health](guide/metrics.md)

-   :material-ship-wheel: **Helm without the binary**

    ---

    List releases, inspect user and computed values, read manifests, browse history,
    roll back and uninstall. The server decodes release secrets itself.

    [:octicons-arrow-right-24: Helm releases](guide/helm.md)

-   :material-keyboard: **Command palette**

    ---

    ++ctrl+k++ searches resources, kinds and pages and runs actions on anything, so
    you can drive the whole app from the keyboard.

    [:octicons-arrow-right-24: Command palette](guide/command-palette.md)

-   :material-shield-lock: **Local & private**

    ---

    Kubus binds to `127.0.0.1` only, guards every request with a per-run token and
    redacts Secret values by default. Nothing leaves your laptop.

    [:octicons-arrow-right-24: Security model](reference/security.md)

</div>

## Kubus in one minute

<div class="kubus-video">
  <iframe
    src="https://www.youtube-nocookie.com/embed/b86yKodD5Mw"
    title="Kubus in one minute"
    allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen>
  </iframe>
</div>

## Get Kubus

<div class="grid cards" markdown>

-   :material-download: **Install Kubus**

    ---

    Grab the desktop installer for Windows, macOS or Linux, or run it from source.

    [:octicons-arrow-right-24: Installation](install/index.md)

-   :material-rocket-launch: **Quickstart**

    ---

    From zero to browsing your first cluster in about five minutes.

    [:octicons-arrow-right-24: Quickstart](quickstart.md)

</div>

!!! info "Kubus is a local tool"

    Kubus runs on your machine against clusters you already have credentials for. It is
    not a hosted, multi-tenant dashboard. The [security model](reference/security.md)
    spells out exactly what that means.
