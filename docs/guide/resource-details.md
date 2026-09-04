---
icon: lucide/file-text
---

# Resource details & YAML

Click any resource name and a **details drawer** slides in from the right. It gives you a
human-friendly view, a browsable manifest *and* the raw YAML, without leaving the list
you're on.

<figure markdown="span">
  ![The resource details drawer for a pod](../assets/screenshots/pod-detail.png#only-light){ .shadow }
  ![The resource details drawer for a pod](../assets/screenshots/pod-detail-dark.png#only-dark){ .shadow }
  <figcaption>A summary strip and per-container panels up top, with tabs for YAML, events, map and metrics.</figcaption>
</figure>

## The tabs

| Tab | Shows | Available for |
| --- | --- | --- |
| **Overview** | A kind-aware summary (see below). | Every kind |
| **Manifest** | The object as a [browsable tree](#the-manifest-tab) or as [YAML](#editing-yaml), editable either way. | Every kind |
| **Schema** | The CRD's OpenAPI schema, with a picker for the served versions. | CustomResourceDefinitions |
| **Events** | Events involving this object, newest first, Warnings highlighted. The tab carries a count of recent warnings before you open it. | Every kind |
| **Map** | A focused [topology graph](topology.md) of what this object relates to. | Every kind |
| **Metrics** | Live CPU/memory [history charts](metrics.md). | Pods, Nodes |
| **History** | Rollout revisions with images and change-cause, and rollback. | Deployments, StatefulSets |

## Kind-aware overviews

The Overview tab adapts to what you're looking at.

Every overview opens with a **summary strip**, the handful of numbers that say how the
object is doing. A *why isn't this ready* banner follows whenever something is wrong, and
collapsible sections hold the rest.

- **Pods** show ready count, restarts, node and IP up top, then one panel per **container**
  with its state, image, restarts, CPU/memory against requests and limits, ports, and its
  own probes, environment, mounts and command a click away. Below that come init and
  ephemeral debug containers, placement and identity details, volumes, scheduling,
  conditions and metadata. Related ConfigMaps, Secrets, PVCs, nodes and owners are all
  clickable.
- **Deployments** show ready/updated/available/unavailable replicas with a rollout
  progress bar, the failing conditions and pod reasons in full, the pod template's
  containers, the pods, and the ReplicaSets still holding pods.
- **Services** show type, cluster IP, ready endpoints and port count; the in-cluster DNS
  name; a ports table (port → targetPort, nodePort) with one-click port forwarding; the
  live **endpoints** from the EndpointSlices with their pods and readiness; and the pods
  the selector matches.
- **Nodes** show roles, pod count, kubelet version, internal IP and condition health, then
  system info, addresses, capacity and the pods on the node.
- **Secrets** show the type and data keys, with values **[redacted](production-guard.md#secrets-are-redacted-by-default)**
  until you explicitly reveal them.
- **NetworkPolicies** spell out what the policy does: the pods it applies to, whether it
  isolates them for ingress or egress, and every rule as readable "from" or "to" peers
  with their ports. A policy that denies everything says so up top.
- **PodDisruptionBudgets** show allowed disruptions against healthy and required pods,
  the covered pods, and a banner when evictions are blocked, which is exactly where a
  node drain would hang. The drain dialog names such budgets before you start.
- **ResourceQuotas** show used against hard per resource as bars, exhausted resources
  first. **LimitRanges** show one table per type with defaults, minimums and maximums.
- **Anything else** shows metadata, owner references, labels and annotations (searchable
  and copyable). The full spec and status live one tab over, in the Manifest tab.

### Links in both directions

Forward links have always been there: a pod's node, a referenced Secret, an owner. The
overview also answers the other question, *who depends on this*:

- **Used by** on ConfigMaps, Secrets, ServiceAccounts, PersistentVolumeClaims and
  Volumes, StorageClasses, PriorityClasses, IngressClasses, Roles and ClusterRoles lists
  every workload, pod, Ingress, route or binding that references the object, and how
  (mounted as a volume, read into an environment variable, used as an image pull
  secret, granted by a binding).
  A Secret that says "mounted by 3 Deployments and a CronJob" before you edit it is the
  point.
- **References** and **Used by** on custom resources work without any hand-written
  matcher. References lists everything the object points at: each field whose name,
  or whose description in the CRD schema, names an installed kind is resolved to that
  object, selectors are resolved against labels, and a reference to something that
  does not exist is shown as not found. Used by is the other direction: the objects
  that name this one, select it by label, or carry its name in a label. A network
  operator's node shows the links, interfaces and fabrics built on it; a parent object
  shows the children the operator tagged with its name.
- The first Used by lookup of a kind reads it once and keeps a live digest of the
  fields that can name other objects, so every later lookup, for any object, answers
  from memory within a fraction of a second. Kinds still being read when the answer
  is sent say so under the list and fill in on the next refresh.
- **Routed by** on a Service lists the Ingresses and Gateway API routes that send
  traffic to it, with their hosts and paths.
- **Selected by** on a Pod or Deployment lists the Services, autoscalers,
  PodDisruptionBudgets and NetworkPolicies whose selectors match it.
- The **namespace** in the drawer header and in Metadata is a link: it opens the
  namespace's overview (the Overview page filtered to that namespace).
- Annotation values that are URLs, and bare hosts under link-shaped keys such as
  `argocd.argoproj.io/url` or a `runbook`, open in a new tab.

Every row in these sections opens the referrer in the drawer, with the usual back stack.
Long lists get a filter box; the pod lists inside Node, Service and Deployment overviews
accept the same `/` [smart filter](smart-filters.md) syntax as the list pages.

!!! tip "Navigate and come back"

    Click a related object, such as a pod's node or a referenced Secret, and the drawer
    follows it, keeping a **back stack**. Use the back arrow to return to where you were.
    The tab you were on (Events, Manifest, Metrics) rides along in the page tab's URL,
    so reopening a closed tab or restarting Kubus brings back the object *and* the tab.

## The Manifest tab

The **Manifest** tab shows the whole object as a tree, one section per top-level key:
Metadata, Spec, Status and whatever else the kind carries (rules, subjects, data). Each
row is a field with its value, and the field's type sits at the right edge. List items
are named after their natural key, so a container shows up as `nginx` rather than `[0]`.
The **Tree / YAML** switch at the start of the toolbar swaps the tree for a
[Monaco editor](#editing-yaml) holding the same object, and Kubus remembers which one
you prefer.

<figure markdown="span">
  ![The Manifest tab for a Deployment](../assets/screenshots/manifest.png#only-light){ .shadow }
  ![The Manifest tab for a Deployment](../assets/screenshots/manifest-dark.png#only-dark){ .shadow }
  <figcaption>Spec and status as aligned key/value rows, with types on the right and locked fields marked.</figcaption>
</figure>

Reading tools:

- **Filter** fields and values from the box at the top. Matching rows stay, their parents
  open, everything else hides.
- **Expand all** and **collapse all** switch between a full dump and the outline. Shallow
  fields start open, long lists start closed.
- The **descriptions** toggle prints each field's documentation from the API schema under
  its row. Off by default; hover a field name for the same text.
- Values that point at other objects are links: a pod's node, a `configMapRef`, an owner
  reference, a scale target. Click one and the drawer follows it with a back stack.
- Timestamps show relative and absolute time, status-like fields get a colored chip, long
  strings clamp with a *Show more*.

Editing works in place:

1. Click a value to edit it. Booleans and enums become pickers, numbers refuse text, and
   `Enter` commits while `Escape` cancels.
2. Hover a row for its actions: copy the value, add a field, add a list item, delete, or
   open the `...` menu to copy the path or replace a whole subtree as YAML. The field
   picker lists what the schema still allows, with descriptions, and accepts any other
   name too. The **+** on a section header adds directly under Spec, Metadata or any
   other top-level key.
3. Changed rows are marked and counted. Each one can be reset on its own, and **Reset**
   drops everything.
4. **Review & apply** shows the YAML diff, runs a server dry-run and only then enables
   **Apply**.

Some rows are locked with a padlock: the status block belongs to the controller, identity
fields (name, namespace, UID, resource version) belong to the API server, and a Secret's
data stays masked and locked until you reveal it. The YAML view of an unrevealed Secret is
read-only for the same reason, and the review diff masks the values while the apply uses
the real ones.

Tree and YAML share one draft. Edit a value in the tree, switch to YAML and the text
already contains it; edit the text, switch back and the tree shows the change. If the
YAML does not parse, the switch waits until it does. Unapplied edits stay with their
resource: close the drawer, browse elsewhere, come back, and the Manifest tab (marked with
a dot) still holds them until you apply or reset them.

The tree is keyboard friendly: arrow keys move between rows, `Right` and `Left` expand and
collapse, `Home` and `End` jump, and `Enter` edits a value.

## Editing YAML

The Manifest tab's **YAML** view is a full [Monaco](https://microsoft.github.io/monaco-editor/)
editor, the same engine that powers VS Code, with syntax highlighting, folding and the
object's API schema for completion and hover help.

1. Switch the Manifest tab to **YAML**.
2. Make your changes.
3. **Dry run** to have the server validate them, then **Replace** to write the object, or
   **Reset** to reload from the server.

### Conflict detection

If the object changed on the server while you were editing, Kubus won't blindly clobber
it. The apply is rejected, you're shown the conflict, the view refreshes to the latest
state, and you can re-apply your change against it. No silent overwrites. In the Manifest
tab a banner offers to **rebase** your edits onto the refreshed object, so you keep them
instead of starting over.

!!! warning "Edits are real"

    Applying YAML patches the live resource immediately. On a
    [protected cluster](production-guard.md), destructive edits are gated behind a typed
    confirmation. There is no undo for a normal edit beyond editing again.

## Creating resources

You don't need an existing object to use the editor. Kubus can open a blank YAML buffer
so you can paste or write a manifest and apply it to create the resource, the same way
`kubectl apply -f` would.

## See also

<div class="grid cards" markdown>

-   :material-lightning-bolt: **[Quick actions](quick-actions.md)** cover scaling, restarting and more without editing YAML.
-   :material-compare: **[Comparing resources](diff.md)** puts two objects side by side.
-   :material-graph-outline: **[Topology](topology.md)** is the Map tab as a full page.

</div>
