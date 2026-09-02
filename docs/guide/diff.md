---
icon: lucide/git-compare
---

# Comparing resources

The **Diff** page puts two resources side by side and highlights what's different. The two
sides can come from different clusters, namespaces or kinds. "Why does this work in
staging but not prod?" usually has its answer here.

<figure markdown="span">
  ![A side-by-side resource diff](../assets/screenshots/diff.png#only-light){ .shadow }
  ![A side-by-side resource diff](../assets/screenshots/diff-dark.png#only-dark){ .shadow }
  <figcaption>Two objects, side by side, with the differences highlighted.</figcaption>
</figure>

## Picking two sides

Open **Diff** from the nav (or ++ctrl+k++ → *Go to Diff*). For each side, choose:

- **Cluster** (any of your selected contexts),
- **Kind**,
- **Namespace** (for namespaced kinds),
- **Name**.

The two objects render in a Monaco diff view, the same side-by-side diff you know from VS
Code.

## Normalise the noise

Server-set fields such as `resourceVersion`, `uid`, `creationTimestamp`, `status` and
managed-fields make almost any two objects look different. The **Normalise** toggle (on by
default) strips that noise so you see the differences that *matter*: spec, labels and the
other things you actually set.

Turn it off when you specifically want to compare status or server metadata.

## Good things to diff

- The same ConfigMap or Deployment in **two clusters** (staging vs prod).
- A resource **before and after** an edit (compare it to a known-good copy).
- Two similar workloads in **different namespaces**.

## See also

<div class="grid cards" markdown>

-   :material-file-document-edit: **[Resource details & YAML](resource-details.md)** lets you edit once you've spotted the difference.
-   :material-ship-wheel: **[Helm releases](helm.md)** compares what two releases rendered.

</div>
