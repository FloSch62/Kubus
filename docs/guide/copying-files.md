---
icon: lucide/folder-tree
---

# Copying files

Move files in and out of a running container — like `kubectl cp`, but with a file picker
and a progress readout.

- **Pod** ⋮ menu → **Files…**

## Download

Enter a path inside the container and download it:

- A **file** downloads as-is.
- A **directory** is streamed out as a `.tar` archive, so you keep the whole tree.

The byte count is shown when the transfer completes.

## Upload

Pick a local file and a destination path in the container:

- A plain path writes the file to exactly that location.
- A path ending in `/` drops the file **into** that directory.

## Requirements

File copy uses the standard streaming trick over `exec`, so the target container needs a
few common binaries:

| To… | The container needs… |
| --- | --- |
| Download or upload a file | `cat` and `tee` |
| Download a directory | `tar` |

!!! tip "Distroless image with no `tar`?"

    Attach a [debug container](shell.md#debug-containers) that *does* have the tools, and
    copy from there.

## See also

<div class="grid cards" markdown>

-   :material-console: **[Shell & debug](shell.md)** — open a terminal in the same container
-   :material-cable: **[Port forwarding](port-forwarding.md)** — reach a service locally

</div>
