---
icon: lucide/rocket
---

# Quickstart

This page takes you from a fresh install to browsing, inspecting and acting on a real
cluster — in about five minutes.

!!! tip "No cluster handy?"

    Spin up two throwaway [kind](https://kind.sigs.k8s.io/) clusters with sample
    workloads (a Helm release, some intentionally broken pods, metrics) using the
    bundled script — see [Test clusters](community/test-clusters.md). They're perfect
    for following along.

## 1. Launch Kubus

Open the **desktop app**, or start it from source:

```bash
pnpm start
```

Kubus opens in a window (or your browser) showing the **Overview** page. On first launch
no clusters are selected yet — that's the next step.

## 2. Select your clusters

Click the **cluster switcher** in the top bar and tick one or more kubeconfig contexts.
Kubus reads the same contexts `kubectl config get-contexts` shows you.

<figure markdown="span">
  ![Selecting kubeconfig contexts in the cluster switcher](assets/screenshots/cluster-switcher.png#only-light){ .shadow }
  ![Selecting kubeconfig contexts in the cluster switcher](assets/screenshots/cluster-switcher-dark.png#only-dark){ .shadow }
  <figcaption>Pick any number of contexts — lists merge across all of them.</figcaption>
</figure>

The moment you select clusters, the **Overview** dashboard fills in: node counts, pod
health, failing workloads and recent warnings, per cluster.

[More on connecting clusters :octicons-arrow-right-24:](guide/clusters.md)

## 3. Browse a resource

Open the left nav and pick a kind — say **Workloads → Pods**. You get a live list that
updates over a WebSocket watch; no refresh button needed. If you selected more than one
cluster, a **Cluster** column tells you where each row lives.

<figure markdown="span">
  ![The Pods list with live status](assets/screenshots/pods.png#only-light){ .shadow }
  ![The Pods list with live status](assets/screenshots/pods-dark.png#only-dark){ .shadow }
  <figcaption>Every kind — including your CRDs — with sortable, filterable columns.</figcaption>
</figure>

Use the **namespace filter** in the top bar to narrow things down.

[More on browsing resources :octicons-arrow-right-24:](guide/browsing-resources.md)

## 4. Inspect something

Click a pod's name. A **details drawer** slides in with:

- an **Overview** tab — status, containers, images, env, volumes, related objects;
- a **YAML** tab — a full Monaco editor you can read or edit;
- **Events**, a relationship **Map**, and (for pods) live **Metrics**.

<figure markdown="span">
  ![The resource details drawer](assets/screenshots/pod-detail.png#only-light){ .shadow }
  ![The resource details drawer](assets/screenshots/pod-detail-dark.png#only-dark){ .shadow }
  <figcaption>A human-friendly overview, plus the raw YAML when you need it.</figcaption>
</figure>

[More on resource details :octicons-arrow-right-24:](guide/resource-details.md)

## 5. Do something

From any row's **⋮ menu** (or the details drawer, or the command palette) you can act:

- :material-text-box-search: **Logs** — stream them, even aggregated across a Deployment's pods
- :material-console: **Shell** — open a terminal straight into a container
- :material-resize: **Scale**, :material-restart: **Rollout restart**, :material-history: **Roll back**
- :material-lan-connect: **Port forward**, :material-file-tree: **Copy files**, :material-delete: **Delete**

Try **Logs** on the `podinfo` deployment, or **Shell** into one of its pods.

## 6. Drive it from the keyboard

Press ++ctrl+k++ (++cmd+k++ on macOS) to open the **command palette**. Type to search
across resources, kinds and pages; press ++tab++ on a result to run an action on it; or
type `>` to run app commands like *Toggle dark / light mode*.

<figure markdown="span">
  ![The command palette](assets/screenshots/command-palette.png#only-light){ .shadow }
  ![The command palette](assets/screenshots/command-palette-dark.png#only-dark){ .shadow }
  <figcaption>++ctrl+k++ — search anything, act on anything, never touch the mouse.</figcaption>
</figure>

## Where to next

<div class="grid cards" markdown>

-   :material-book-open-variant: **User guide**

    ---

    A feature-by-feature tour of everything Kubus can do.

    [:octicons-arrow-right-24: Read the guide](guide/index.md)

-   :material-shield-lock: **Security model**

    ---

    Exactly how Kubus keeps things local and what the production guard does.

    [:octicons-arrow-right-24: Security](reference/security.md)

</div>
