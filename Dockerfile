# syntax=docker/dockerfile:1
#
# Kubus server + web UI as an OCI image, for running Kubus in a cluster or on a
# shared host and opening it in a browser. See docs/install/container.md.
#
#   docker build -t kubus .
#   docker buildx build --platform linux/amd64,linux/arm64 -t kubus .
#
# Every build step runs on the build platform: the Helm engine is WASI and the
# server has no native modules, so the output is architecture-independent and
# the final stage only copies files (no emulation needed for arm64).

ARG NODE_VERSION=24.22.1
ARG GO_VERSION=1.27.3
ARG PNPM_VERSION=12.15.0

# ---- Helm engine (Go -> WASI) ---------------------------------------------
FROM --platform=$BUILDPLATFORM docker.io/library/golang:${GO_VERSION}-trixie AS helm-engine
WORKDIR /src/helm-engine
COPY helm-engine/go.mod helm-engine/go.sum ./
RUN go mod download
COPY helm-engine/ ./
RUN GOOS=wasip1 GOARCH=wasm go build -trimpath -ldflags='-s -w' -o /helm-engine.wasm . \
 && gzip -9 -n -c /helm-engine.wasm > /helm-engine.wasm.gz

# ---- Server + client ------------------------------------------------------
FROM --platform=$BUILDPLATFORM docker.io/library/node:${NODE_VERSION}-trixie-slim AS build
ARG PNPM_VERSION
RUN npm install -g --no-fund --no-audit pnpm@${PNPM_VERSION}
WORKDIR /src
# Electron is not part of the image; skip its postinstall binary download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    CI=1
COPY . .
RUN pnpm install --frozen-lockfile \
      --filter @kubus/shared --filter @kubus/server --filter @kubus/client \
 && pnpm --filter @kubus/shared --filter @kubus/server --filter @kubus/client build \
 && pnpm --filter @kubus/server --config.allow-unused-patches=true deploy --prod --legacy /out/server \
 && cp -r client/dist /out/client-dist \
 && cp package.json /out/package.json

# ---- Runtime --------------------------------------------------------------
FROM docker.io/library/node:${NODE_VERSION}-trixie-slim
LABEL org.opencontainers.image.title="Kubus" \
      org.opencontainers.image.description="Kubus Kubernetes GUI (server + web UI)" \
      org.opencontainers.image.source="https://github.com/FloSch62/Kubus" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# Layout mirrors the repo so the server finds ../../client/dist and
# ../../assets/helm-engine.wasm.gz relative to server/dist.
COPY --from=build /out/package.json /app/package.json
COPY --from=build /out/server /app/server
COPY --from=build /out/client-dist /app/client/dist
COPY --from=helm-engine /helm-engine.wasm.gz /app/server/assets/helm-engine.wasm.gz
# Listen on all interfaces inside the container; no browser to open. With no
# kubeconfig mounted, the pod's ServiceAccount is used (in-cluster config).
ENV NODE_ENV=production \
    KUBUS_HOST=0.0.0.0 \
    KUBUS_NO_OPEN=1 \
    PORT=3001 \
    HOME=/home/node
USER node
EXPOSE 3001
CMD ["node", "/app/server/dist/index.js"]
