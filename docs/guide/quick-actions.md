---
icon: lucide/zap
---

# Quick actions

Most of what you'd reach for `kubectl` to do, Kubus does from a menu. Every list row has a
**⋮ menu**, and the same actions are available from the [details drawer](resource-details.md)
and the [command palette](command-palette.md).

Actions only appear where they make sense — you'll never see *Cordon* on a ConfigMap.

## Workloads

| Action | Applies to | What it does |
| --- | --- | --- |
| **Rollout restart** | Deployment, StatefulSet, DaemonSet | Triggers a rolling restart (like `kubectl rollout restart`). |
| **Scale…** | Deployment, StatefulSet, ReplicaSet | Set the replica count. Warns if an HPA/KEDA will fight you. |
| **Pause / Resume rollout** | Deployment | Freeze or resume the rollout. |
| **Set image…** | Deployment, StatefulSet, DaemonSet | Swap the image on any container or init container. |
| **Restart pods…** | ReplicaSet | Deletes the managed pods so they're recreated. |
| **Re-run** | Job | Creates a fresh Job from the same template. |
| **Trigger now…** | CronJob | Creates a Job immediately, off-schedule — with the generated Job YAML shown for review and one-off edits first. |
| **Suspend / Resume** | CronJob | Pause or resume scheduling. |

### Scaling

The **Scale** dialog shows the current replica count and lets you set a new one. If a
**HorizontalPodAutoscaler** or KEDA `ScaledObject` targets the workload, Kubus warns you —
because the autoscaler will likely override a manual change.

### Rollout history & rollback

Open a Deployment or StatefulSet's details drawer and switch to the **History** tab. You
get every revision with its images and change-cause, the current one clearly marked, and a
**Roll back** button on the others — exactly like `kubectl rollout undo`, but you can see
what you're rolling back to first.

<figure markdown="span">
  ![Rollout history with rollback buttons](../assets/screenshots/rollout-history.png#only-light){ .shadow }
  ![Rollout history with rollback buttons](../assets/screenshots/rollout-history-dark.png#only-dark){ .shadow }
  <figcaption>Browse revisions, then roll back to any of them.</figcaption>
</figure>

## Nodes

| Action | What it does |
| --- | --- |
| **Cordon / Uncordon** | Mark the node un/schedulable. |
| **Drain…** | Cordon, then evict all non-DaemonSet pods — with **live progress** (evicted *X / Y*). |
| **Node shell…** | Open a [privileged root shell on the node](shell.md#node-shell). |

The **Drain** dialog streams progress as it evicts, so you can watch a node empty out in
real time rather than staring at a spinner.

## Everything: delete

**Delete…** is available on every kind. You'll always get a confirmation; on a
[protected cluster](production-guard.md) you'll be asked to **type the resource name**
first, so a stray click can't take something down.

!!! danger "Destructive actions and the production guard"

    Delete, scale-to-zero, drain, cordon and node shell are gated by the
    [production guard](production-guard.md) on clusters you mark as protected. The guard
    is a UI safety net against slips — it is **not** a server-side permission boundary.
    For real authorization, use Kubernetes RBAC.

## Run actions from anywhere

- **Row menu** — the ⋮ on any list row.
- **Details drawer** — the same actions while you're inspecting an object.
- **Command palette** — press ++ctrl+k++, find a resource, press ++tab++, and pick an
  action. [More →](command-palette.md)

## See also

<div class="grid cards" markdown>

-   :material-script-text: **[Logs](logs.md)** — check what a workload is doing before you act
-   :material-console: **[Shell & debug](shell.md)** — get a terminal into a container or node

</div>
