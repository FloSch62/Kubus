---
icon: lucide/git-pull-request
---

# Contributing

Thanks for considering a contribution! Kubus is a community project and every bit helps —
from typo fixes to whole features.

## Ways to help

- :material-bug: **Report a bug** — open an issue with steps to reproduce, your platform,
  and what you expected.
- :material-lightbulb: **Suggest a feature** — describe the problem you're trying to solve,
  not just the solution.
- :material-file-document: **Improve the docs** — every page has an edit pencil that takes
  you straight to its source.
- :material-code-tags: **Send a pull request** — see below.

## Before you open a PR

1. [Build from source](development.md) and get the dev servers running.
2. Make your change, keeping the surrounding code's style and conventions.
3. Run the checks:

    ```bash
    pnpm typecheck
    pnpm lint
    ```

4. If you touched behaviour, make sure it works against the
   [test clusters](test-clusters.md).

## Pull request tips

- Keep PRs focused — one logical change per PR is easier to review.
- Describe **what** and **why**, and link any related issue.
- Screenshots or a short clip help enormously for UI changes.

## Editing the docs

These docs are built with [Zensical](https://zensical.org) and live in `docs/`. To preview
them locally:

```bash
uvx zensical serve   # then open http://localhost:8000
```

Edit the Markdown, and the preview reloads as you save. See
[Building from source](development.md) for the rest of the dev setup.

## Code of conduct

Be kind and constructive. Assume good intent, keep discussions technical, and help newcomers.
