# Release pipeline

How prebuilt per-OS release archives are cut. The pipeline lives in `.github/workflows/release.yml` and runs on the GitHub repository (GitHub Actions); GitLab CI does not run it.

## Cutting a release

1. Make sure `package.json` has the version you want to ship (the workflow refuses tags that do not match it).
2. Push a tag to the GitHub repo: `v<version>` for a real release (for example `v0.6.8`), or `v<version>-<suffix>` for a prerelease (for example `v0.6.8-rc.1`). Any tag containing `-` is published as a GitHub prerelease.

The workflow then:

- checks the vendored Node pin for missed security releases (a release must not ship a Node with known holes),
- asserts the tag matches the `package.json` version (prerelease suffixes allowed),
- builds three archives via `scripts/bundle-release.mjs`, one per target on its native runner: `linux-x64` (tar.gz), `darwin-arm64` (tar.gz), `win-x64` (zip),
- smoke-tests each archive on a bare runner with no provisioned toolchain (`scripts/smoke-release-archive.mjs`), and verifies each archive against its `.sha256` file,
- assembles `SHA256SUMS.txt`, re-verifies every downloaded archive against it (so artifact-storage corruption between the smoke jobs and publish cannot ship a broken asset), and creates the GitHub Release with the archives and checksums attached. Checksums are computed in CI from the tagged commit.

Re-running the publish for a tag that already has a release requires deleting that release first: `gh release create` fails if the release already exists.

## Dry runs without publishing

Trigger the "Release" workflow manually (workflow_dispatch) to run the whole pipeline, including builds and bare-machine smokes, without creating a release. The publish job only runs on tag push events, never on manual runs (even a manual run aimed at a tag ref stays a dry run); the tag-version guard passes as a no-op on manual runs.

## The vendored Node pin

The archives bundle their own Node runtime. Its version is pinned in `scripts/release-node-version.json` (single source of truth; `node scripts/bundle-release.mjs --print-node-version` prints it), together with the sha256 of each per-target nodejs.org archive. The pin file is the trust anchor: `bundle-release.mjs` verifies every downloaded Node archive against the pinned hash and hard-fails on mismatch, instead of trusting whatever checksum file nodejs.org serves at build time.

`scripts/check-node-currency.mjs` compares the pin against the official nodejs.org release index. It fails when a newer release in the same major line is marked as a security release, warns on ordinary newer patches, and fails on a pin that does not exist in the index. The "Node currency" workflow (`.github/workflows/node-currency.yml`) runs it weekly and on changes to the pin or the check itself, and the release workflow runs it before every build.

To bump the pin: edit the version in `scripts/release-node-version.json` and update the three hashes (`win-x64` for `node-v<version>-win-x64.zip`, `darwin-arm64` for `node-v<version>-darwin-arm64.tar.gz`, `linux-x64` for `node-v<version>-linux-x64.tar.xz`) from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`. That checksum file is itself PGP-signed as `SHASUMS256.txt.asc`, so the pinned values can be independently verified against the signed file before the MR is approved. Then let CI go green and cut a new release so users actually receive the patched runtime.
