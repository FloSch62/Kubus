# Native grid scrolling

`@mui/x-virtualizer@0.7.0.patch` covers both module entry points. Kubus uses
DataGrid's native (`uncontrolled`) scroll layout with read-only resource cells.
The upstream layout replenishes its render window on every crossed row and
renders fifteen extra rows in the direction of travel. In WebKitGTK, repeated
synchronous React commits and mounting those cells interrupt scrolling.

The patch uses the existing half-buffer replenishment check for native scrolling
and a four-row directional buffer. Direction changes and large jumps still
replenish immediately. Controlled layout behavior is unchanged. The mounted row
buffer remains bounded; we do not disable virtualization or drop resources.

When upgrading MUI, re-evaluate and remove this patch if upstream addresses the
native scroll behavior. Verify wheel movement, fast jumps in both directions,
horizontal scrolling, keyboard focus, selection, and drawer resizing in the
native desktop performance suite, as well as the WebKit browser suite. The
performance suite compares native wheel pacing with a plain overflow control;
it also enforces frame-time budgets for sustained table scrolling.
