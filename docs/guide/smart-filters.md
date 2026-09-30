---
icon: lucide/filter
---

# Smart filters

Every resource list has a search box. By default it's a plain text search, so every word
you type has to appear somewhere in the row (name, namespace, cluster, status, node,
images or labels). Start your query with a **`/`** and it becomes a smart filter, with
structured clauses for status categories, numeric comparisons, labels and ages that
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
- **Negate** with `!`: both `/!ns:kube-system` and `/status:!running` work.
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
| `uid:` | object UID contains; a prefix is enough | `/uid:3f2a9c1e` |

`uid:` helps when an event, an audit log or an owner reference names an object only by
its UID. Paste the UID (or its first few characters) into the list of that kind to find
the object. On the Events list it also matches the UID of the object an event is about.

`status:` understands aliases beyond the literal status text:

- `crash` → CrashLoopBackOff, `oom` → OOMKilled
- `error` → errors, failures and backoffs of any flavour
- `unhealthy` → anything not fully up, `healthy` → the rest; works for pods, workloads
  and nodes
- `degraded` / `progressing` → workloads with fewer ready replicas than desired
- `completed` → Succeeded pods and complete Jobs

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
    Percentages (`cpu>80%`) compare against capacity where Kubus knows it, such as node
    utilisation.

## Filtering by label

The search box also holds a server-side label selector, shown as tokens at its start.
Type part of a label and the suggestions list the matching keys and `key=value` pairs
present in the rows; pick one to add it as a token. A selector typed as-is, such as
`env!=prod`, `!canary` or `tier in (web,api)`, becomes a token when you press ++enter++.
A plain word stays a text search, so for a bare key write `label:team`. Tokens are ANDed
together. Click a token's ✕ to remove it, or press ++backspace++ in the empty field to
remove the last one.

To browse instead of typing, click the label icon (:material-tag-outline:) at the end of
the search box. It lists every label key in the list, most common first, with its values
and how many rows carry each. Tick as many as you like; the panel stays open while you
pick. A search box at the top narrows the list, and a selector field at the bottom takes
anything the list can't offer. When more tokens are set than fit in the search box, the
`+N` chip opens the same panel, where each one can be removed.

Every row also shows its labels as chips in the **Labels column**. Hover to see them
all, and click a chip to add it to the label filter.

## Saved views remember your filter

A smart filter is part of the page URL, so [saved views](browsing-resources.md#saved-views)
capture it. Save *`/status:unhealthy` in prod* once and it's one click from the nav
drawer from then on.

## See also

<div class="grid cards" markdown>

-   :material-table: **[Browsing resources](browsing-resources.md)** covers the lists these filters power.
-   :material-keyboard: **[Command palette](command-palette.md)** fuzzy-finds across every kind at once.

</div>
