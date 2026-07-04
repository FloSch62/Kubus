---
icon: lucide/filter
---

# Smart filters

Every resource list has a search box. By default it's a plain text search — every word
you type has to appear somewhere in the row (name, namespace, cluster, status, node,
images or labels). Start your query with a **`/`** and it becomes a smart filter:
**structured clauses** for status categories, numeric comparisons, labels and ages that
narrow thousands of pods down to the ones that matter in one line:

```
/status:crash ns:prod cpu>500m restarts>3
```

The moment you type `/`, Kubus **autocompletes** the keys that make sense for the kind
you're looking at, including live values (your namespaces, clusters and nodes).

## How queries work

- The query starts with `/`; everything after it is the smart filter.
- Clauses are separated by spaces and **ANDed** together.
- A clause is either free text (`nginx`) or `key:value` / `key>value` / `key<value`.
- **OR** alternatives with a comma: `/status:crash,oom`, `/ns:dev,staging`.
- **Negate** with `!` — `/!ns:kube-system` or `/status:!running` both work.
- Quotes protect spaces: `/name:"billing worker"`.
- Everything is case-insensitive, and an unknown key just falls back to free text.

## Universal keys

| Key | Matches | Example |
| --- | --- | --- |
| `name:` | name contains | `/name:api` |
| `ns:` / `namespace:` | namespace contains | `/ns:prod` |
| `cluster:` / `ctx:` | cluster contains | `/cluster:staging` |
| `label:` | exact label, or key presence; `*` globs | `/label:app=nginx`, `/label:team` |
| `annotation:` | exact annotation, or key presence | `/annotation:owner=platform` |
| `age>` / `age<` | resource age (`s`, `m`, `h`, `d`, `w`) | `/age>7d`, `/age<30m` |
| `status:` | status text or a category alias | `/status:degraded` |

`status:` understands aliases beyond the literal status text:

- `crash` → CrashLoopBackOff, `oom` → OOMKilled
- `error` → errors, failures and backoffs of any flavour
- `unhealthy` / `healthy` — anything not fully up (works for pods, workloads and nodes)
- `degraded` / `progressing` — workloads with fewer ready replicas than desired
- `completed` — Succeeded pods and complete Jobs

## Kind-specific keys

| Key | Kinds | Example |
| --- | --- | --- |
| `restarts>` | Pods | `/restarts>5` |
| `node:` | Pods | `/node:worker-1` |
| `image:` | Pods | `/image:redis` |
| `cpu>` / `mem>` | Pods, Nodes | `/cpu>500m`, `/mem>1Gi`, `/cpu>80%` |
| `ready:` | Pods, Nodes, workloads | `/ready:false` |
| `replicas>` | Deployments, StatefulSets, … | `/replicas>3` |
| `type:` | Services | `/type:lb`, `/type:np` |
| `reason:` / `message:` | Events | `/reason:BackOff` |

!!! tip "Absolute quantities, not just percentages"

    `cpu>` and `mem>` take real Kubernetes quantities (`250m`, `1.5`, `512Mi`, `2Gi`).
    Percentages (`cpu>80%`) compare against capacity where Kubus knows it — node
    utilisation, for example.

## Filtering by label

Next to the search box, the **Labels** dropdown filters server-side by label selector.
It lists every label key and `key=value` pair present in the rows — tick as many as you
like (they're ANDed together), or type a raw selector like `env!=prod` and press ++enter++.

Every row also shows its labels as chips in the **Labels column** — hover to see them
all, and click a chip to add it to the label filter.

## Saved views remember your filter

A smart filter is part of the page URL, so [saved views](browsing-resources.md#saved-views)
capture it — save *`/status:unhealthy` in prod* once and it's one click from the nav
drawer forever.

## See also

<div class="grid cards" markdown>

-   :material-table: **[Browsing resources](browsing-resources.md)** — the lists these filters power
-   :material-keyboard: **[Command palette](command-palette.md)** — fuzzy-find across every kind at once

</div>
