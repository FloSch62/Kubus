# Kubus

Kubus is a free, open-source Kubernetes GUI for working across clusters from
your local machine. It uses your existing kubeconfig to browse and edit
resources, stream logs, open shells, forward ports, watch metrics, inspect Helm
releases, and more.

**The docs are the main entry point:** [kubus-app.dev](https://kubus-app.dev/)

[![vid](docs/assets/overview-play.png)](https://www.youtube.com/watch?v=b86yKodD5Mw)

## Start Here

- [Install Kubus](https://kubus-app.dev/install/)
- [Quickstart](https://kubus-app.dev/quickstart/)
- [User guide](https://kubus-app.dev/guide/)
- [Reference](https://kubus-app.dev/reference/)
- [Contributing and development](https://kubus-app.dev/community/)
- [Desktop releases](https://github.com/FloSch62/Kubus/releases)


## Run From Source

Requires Node.js >= 24.20 and pnpm 11:

```bash
pnpm install
pnpm build
pnpm start
```

For development setup, release steps, architecture, security details, and test
clusters, use the docs.

## Build Artifacts

Run the **Build artifacts** workflow from GitHub's **Actions** tab: select
**Run workflow**, choose a branch, and start the run. It builds Linux
(`.AppImage`, `.deb`), macOS (`.dmg`), and Windows (`.exe`) installers without
running tests or publishing a release. Download the platform archives from
the completed run's **Artifacts** section; they are retained for 14 days.

## Support

<a href="https://www.buymeacoffee.com/FloSch62">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me a Coffee" height="60">
</a>

## License

[MIT](./LICENSE)
