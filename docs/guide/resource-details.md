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
| **Manifest** | The object as a [browsable tree](#the-manifest-tab): every field with its value, type and description, editable in place. | Every kind |
| **YAML** | A Monaco editor to read or [edit](#editing-yaml) the object. | Every kind |
| **Schema** | The CRD's OpenAPI schema, with a picker for the served versions. | CustomResourceDefinitions |
| **Events** | Events involving this object, newest first, Warnings highlighted. | Every kind |
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
- **Anything else** shows metadata, owner references, labels and annotations (searchable
  and copyable). The full spec and status live one tab over, in the Manifest tab.

!!! tip "Navigate and come back"

    Click a related object, such as a pod's node or a referenced Secret, and the drawer
    follows it, keeping a **back stack**. Use the back arrow to return to where you were.

## The Manifest tab

The **Manifest** tab shows the whole object as a tree, one section per top-level key:
Metadata, Spec, Status and whatever else the kind carries (rules, subjects, data). Each
row is a field with its value, and the field's type sits at the right edge. List items
are named after their natural key, so a container shows up as `nginx` rather than `[0]`.

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
data stays locked until you reveal it.

The Manifest and YAML tabs share one draft. Edit a value in the tree, switch to YAML and
the text already contains it; edit the text, switch back and the tree shows the change.
If the YAML does not parse, the tab switch waits until it does. Leaving the resource with
unapplied edits asks first.

The tree is keyboard friendly: arrow keys move between rows, `Right` and `Left` expand and
collapse, `Home` and `End` jump, and `Enter` edits a value.

## Editing YAML

The **YAML** tab is a full [Monaco](https://microsoft.github.io/monaco-editor/) editor,
the same engine that powers VS Code, with syntax highlighting and folding.

1. Switch the tab to **edit** mode.
2. Make your changes.
3. **Apply** to patch the live object, or **Reset** to reload from the server.

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
