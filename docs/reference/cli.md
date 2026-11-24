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
| `--host <addr>` | `127.0.0.1` | `KUBUS_HOST` | Address to listen on. Only change it for [container deployments](../install/container.md). |
| `--auth <mode>` | `token` | `KUBUS_AUTH` | `none` turns off the access token, for running behind an authenticating reverse proxy. |
| `--offline` | off | `KUBUS_OFFLINE=1` | For air-gapped clusters: refuse everything that needs the public internet (update check, Artifact Hub, one-click network-agent install). Private Helm repositories keep working. |
| `--allowed-origins <list>` | *(loopback only)* | `KUBUS_ALLOWED_ORIGINS` | Comma-separated browser origins (e.g. `https://kubus.example.com`) allowed besides loopback. |

!!! note "Passing flags through pnpm"

    With `pnpm start` you need the `--` separator so the flags reach the server rather
    than pnpm:

    ```bash
    pnpm start -- --kubeconfig ~/.kube/staging.yaml --port 8080
    ```

## How it binds

- By default the server listens on **`127.0.0.1`** only. It is not reachable from other
  machines on your network. The [container image](../install/container.md) sets
  `KUBUS_HOST=0.0.0.0` because the container's network is its boundary.
- On startup it prints (and, unless `--no-open` is set, opens) a URL of the form:

  ```
  http://127.0.0.1:<port>/?token=<random-token>
  ```

## The access token

Every run mints a fresh random **bearer token**. The browser receives it in the launch
URL, and every API and WebSocket request must carry it. This protects the local server
against DNS-rebinding and CSRF from other pages in your browser. The token isn't
persisted, so every restart gives you a new one.

See the [security model](security.md) for the full picture.

## Environment variables

| Variable | Equivalent to |
| --- | --- |
| `KUBECONFIG` | `--kubeconfig` |
| `PORT` | `--port` |
| `KUBUS_NO_OPEN=1` | `--no-open` |
| `KUBUS_HOST` | `--host` |
| `KUBUS_AUTH` | `--auth` |
| `KUBUS_OFFLINE=1` | `--offline` |
| `KUBUS_ALLOWED_ORIGINS` | `--allowed-origins` |

## See also

<div class="grid cards" markdown>

-   :material-shield-lock: **[Security model](security.md)** goes deeper on the token and local-only binding.
-   :material-cog: **[Settings](../guide/settings.md)** covers preferences set inside the app.

</div>
