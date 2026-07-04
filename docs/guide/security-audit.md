---
icon: lucide/shield-alert
---

# Security audit

Kubus ships a built-in security audit: **32 checks** across pod security, RBAC, network
exposure, secrets hygiene, workload resilience and node health — run on demand, entirely
against the live cluster, with **no agent to install**.

Open **Security Audit** from the nav (or ++ctrl+k++ → *Go to Security Audit*). Kubus scans
every selected cluster and groups what it finds by check, ordered by severity.

## What gets checked

| Category | Examples |
| --- | --- |
| **Pod security** | privileged containers, host network/PID/IPC, hostPath and runtime-socket mounts, dangerous capabilities, root users, writable root filesystems, missing limits/requests, `:latest` images, seccomp/AppArmor disabled |
| **RBAC** | wildcard rules, `cluster-admin` bindings, escalate/bind/impersonate verbs, broad secrets read access |
| **Network** | Ingresses without TLS, NodePort services, namespaces with pods but no NetworkPolicy |
| **Secrets** | credential-looking literals in env vars and ConfigMaps |
| **Resilience** | single-replica workloads, multi-replica workloads without a PodDisruptionBudget, missing probes |
| **Nodes** | nodes that aren't Ready |

Findings attach to the **owning workload**, not each replica — one noisy Deployment is one
finding, not thirty. Every finding links straight to the resource: click it and the
[details drawer](resource-details.md) opens, ready for you to fix the YAML.

## Working the report

- **Severity chips** (critical / high / medium / low) filter the report with one click.
- **Free-text filter** narrows by resource, namespace, message or check.
- **Dismiss a check** you've decided to accept — it moves to a *Dismissed checks* list at
  the bottom and stays out of the report until you restore it. Dismissals persist.
- **Multi-cluster** — findings from every selected cluster appear in one report, each
  tagged with its cluster.

## Export

Take the report with you:

- **JSON** — the raw findings, for scripting.
- **SARIF** — standard [SARIF 2.1.0](https://sarifweb.azurewebsites.net/), ready for GitHub
  code scanning, VS Code SARIF viewers and security dashboards.

!!! note "Scoped by your RBAC"

    The audit sees exactly what your kubeconfig user can list. If RBAC objects (or any
    other kind) can't be read, the report says so and the remaining checks still run.

## See also

<div class="grid cards" markdown>

-   :material-shield-lock: **[Production guard & secrets](production-guard.md)** — Kubus's own safety net
-   :material-file-document-edit: **[Resource details & YAML](resource-details.md)** — fix findings in place

</div>
