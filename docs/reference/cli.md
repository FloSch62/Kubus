---
icon: lucide/terminal
---

# Command-line flags

When you run Kubus from source (or wrap the binary), the server takes a handful of flags
and environment variables. The desktop app sets sensible equivalents for you.

```bash
pnpm start -- [flags]
# or, against a built server:
node server/dist/index.js [flags]
```

## Flags

| Flag | Default | Environment variable | Description |
| --- | --- | --- | --- |
| `--port <n>` | `3001` | `PORT` | Port to listen on. |
| `--kubeconfig <path>` | `~/.kube/config` | `KUBECONFIG` | Path to the kubeconfig to read contexts from. |
| `--no-open` | *(opens browser)* | `KUBUS_NO_OPEN=1` | Don't open a browser on startup. |

!!! note "Passing flags through pnpm"

    With `pnpm start` you need the `--` separator so the flags reach the server rather
    than pnpm:

    ```bash
    pnpm start -- --kubeconfig ~/.kube/staging.yaml --port 8080
    ```

## How it binds

- The server listens on **`127.0.0.1`** only — never `0.0.0.0`. It is not reachable from
  other machines on your network.
- On startup it prints (and, unless `--no-open` is set, opens) a URL of the form:

  ```
  http://127.0.0.1:<port>/?token=<random-token>
  ```

## The access token

Every run mints a fresh random **bearer token**. The browser receives it in the launch
URL, and every API and WebSocket request must carry it. This protects the local server
against DNS-rebinding and CSRF from other pages in your browser. The token isn't persisted
— restart Kubus and you get a new one.

See the [security model](security.md) for the full picture.

## Environment variables

| Variable | Equivalent to |
| --- | --- |
| `KUBECONFIG` | `--kubeconfig` |
| `PORT` | `--port` |
| `KUBUS_NO_OPEN=1` | `--no-open` |

## See also

<div class="grid cards" markdown>

-   :material-shield-lock: **[Security model](security.md)**
-   :material-cog: **[Settings](../guide/settings.md)** — preferences set inside the app

</div>
