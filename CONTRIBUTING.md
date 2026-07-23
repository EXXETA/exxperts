# Contributing to exxperts

Thanks for your interest in improving exxperts. Issues and pull requests are welcome, and this page explains how to get a change from your machine into `main`.

## Found a bug or have an idea?

Open a [GitHub issue](https://github.com/EXXETA/exxperts/issues). The most useful reports include your platform (macOS/Windows/Linux), Node and npm versions, the exact command or click path, and what you expected versus what happened. Screenshots help a lot. If `npm run doctor` (from the repo folder) prints anything red, include that too.

Small fix already in hand? Feel free to skip the issue and open the pull request directly.

## Setting up for development

Prerequisites are the same as the [README install section](README.md#install): Node.js 20.6+ and npm. On Windows, apply the Git settings from the [quickstart Windows notes](docs/quickstart.md#windows-notes) first and clone into a folder your user owns.

```bash
git clone https://github.com/EXXETA/exxperts.git
cd exxperts
npm install
npm run build
./scripts/exxperts-web     # dev web app (server + UI)
./scripts/exxperts-cli     # dev CLI/TUI
```

The repository layout and day-to-day developer commands are documented in [`docs/developer.md`](docs/developer.md). For an orientation on the product itself (rooms, memory lifecycle, tool policy), read [`docs/how-exxperts-works.md`](docs/how-exxperts-works.md).

## Before you open a pull request

1. **Build cleanly:** `npm run build` from the repo root.
2. **Run the smoke suite:** `npm run smokes`. It must pass completely. The suite is fast and is the same gate CI runs.
3. **Keep the change focused.** One fix or one feature per PR reviews quickly; mixed PRs stall.
4. **Match the surrounding code.** Follow the style, naming, and comment density of the files you touch. No reformatting-only changes, please.
5. If your change affects behavior a user can see, update the relevant page under `docs/` in the same PR.

Platform note: exxperts supports macOS, Windows, and Linux. If your change touches process handling, file paths, or anything shell-adjacent, be suspicious of platform differences. CI will check all three, but a moment of thought saves a red build.

## What happens to your PR

Merging to `main` is gated automatically:

- **CI must be green on three platforms** (ubuntu, macos, windows): build plus the full smoke suite.
- **A code owner must approve.** The maintainers (see [`.github/CODEOWNERS`](.github/CODEOWNERS)) review every PR; other reviews are welcome but do not replace an owner's approval.
- **History is append-only.** No force pushes; keep your PR branch and we squash or merge as fits.

The maintainers develop on an internal repository and publish to this one. When your PR is accepted, the change is cherry-picked into the internal mainline with you as the commit author and arrives back here with the next sync. Because of that flow, the PR itself shows as closed rather than merged; the closing comment links your landed commit. Your authorship is preserved either way, and the changelog credits you.

## License

exxperts is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). By submitting a contribution you agree that it is provided under the same license.

## Questions

Not sure whether something is a bug, or whether a feature fits the product? Open an issue and ask. Short questions get short answers quickly.
