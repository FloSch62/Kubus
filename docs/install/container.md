---
icon: lucide/container
---

# Container image

Kubus can also run as an OCI container: the same server and web UI as the desktop
app, opened in a browser. Use it to run Kubus **inside the cluster** it manages, or on a
shared admin host, so nobody needs a kubeconfig on their laptop.

!!! warning "One shared identity"

    A container deployment acts with **one** set of credentials: the pod's
    ServiceAccount, or the kubeconfig you mount. Everyone who can open the UI can do
    whatever those credentials allow. Grant only the RBAC you want every user to have,
    and keep the UI behind a login (see [behind a reverse proxy](#behind-a-reverse-proxy)).

## Build

```bash
docker build -t kubus .
# multi-arch
docker buildx build --platform linux/amd64,linux/arm64 -t registry.example.com/kubus:dev --push .
```

`podman build` works the same way. Every build step runs on the build platform (the Helm
engine is WASI and the server has no native modules), so building for arm64 on an amd64
machine needs no emulation.

## Run with a kubeconfig

```bash
docker run --rm -p 127.0.0.1:3001:3001 \
  -v ~/.kube/config:/home/node/.kube/config:ro \
  kubus
```

Open the `Kubus ready at http://0.0.0.0:3001/?token=…` URL from the log, with `0.0.0.0`
replaced by `localhost`. The token is random per start, exactly as on the desktop.

Kubeconfigs that use exec plugins (`aws`, `gcloud`, `kubelogin`, …) need those binaries
in the image; static tokens and client certificates work as is.

## Run in the cluster

With no kubeconfig mounted, Kubus uses the pod's ServiceAccount (in-cluster config); the
cluster shows up as the context `inClusterContext`. An example with a read-only RBAC
binding, a non-root, read-only-root-filesystem pod and health probes lives in
[`deploy/kubernetes/kubus.yaml`](https://github.com/FloSch62/Kubus/blob/main/deploy/kubernetes/kubus.yaml):

```bash
kubectl apply -f deploy/kubernetes/kubus.yaml
kubectl -n kubus port-forward svc/kubus 3001:3001
kubectl -n kubus logs deploy/kubus | grep 'Kubus ready'
```

Run a single replica: watches, terminals and log streams live in the server process.

## Behind a reverse proxy

To publish Kubus on a hostname, put it behind an ingress that **authenticates**
(for example forward-auth to your SSO). Kubus then does not need its own token:

| Variable | Flag | Value |
| --- | --- | --- |
| `KUBUS_AUTH` | `--auth` | `none`: no Kubus token; the proxy decides who gets in |
| `KUBUS_ALLOWED_ORIGINS` | `--allowed-origins` | the public URL(s), comma-separated, e.g. `https://kubus.example.com` |

With `--auth none`, Kubus still rejects API and WebSocket requests whose `Host` header or
browser `Origin` is not loopback or one of the allowed origins. That keeps other web
pages (and DNS rebinding) from driving the API through a logged-in browser. The proxy
must forward the original `Host` header (the default for Traefik and ingress-nginx) and
support WebSockets.

`--auth none` on a non-loopback `--host` refuses to start without
`--allowed-origins`.

!!! danger "Never expose `--auth none` without a proxy that authenticates"

    Anyone who reaches the port gets the full rights of the ServiceAccount.
    Restrict the Service to the ingress (for example with a NetworkPolicy).

## Health check

`GET /healthz` answers `{"ok":true}` without authentication, for liveness and readiness
probes.

## Desktop-only features

Some features act on the machine the server runs on. In a container that is the pod,
not your laptop:

- **Port forwarding** opens the local port inside the container.
- **SSH tunnels**, **kubeconfig import/edit** and **settings** write to the container's
  filesystem and are lost on restart unless you mount a volume at `/home/node`.
