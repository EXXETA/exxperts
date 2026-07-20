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

## How the installers consume releases

The one-line installers (`install.sh` / `install.ps1`) are archive-first: they look up the newest release on GitHub whose assets include the platform's archive, download it, check it against `SHA256SUMS.txt` (a corruption check, not a signature), and install it. While the archive channel is in beta, that lookup deliberately includes prereleases: a `v*-rc.*` prerelease with archives IS what the installers pick up, so cutting one ships it to everyone who runs the one-liner. Archive installs land in `~/.local/share/exxperts` with a `~/.local/bin/exxperts` launcher (macOS/Linux) or `%LOCALAPPDATA%\Programs\exxperts` with a `%LOCALAPPDATA%\Programs\exxperts\bin` entry prepended to the user `Path` (Windows). Re-running the installer updates in place, preserving the install's `app/.env`; user state in `~/.exxperts` is never written by the installer. When no archive is available for the platform or the download fails, the same command falls back to the legacy clone-and-build flow.

The env-var contract for forcing either path:

- `EXXPERTS_INSTALL_METHOD=archive` forces the archive path: a hard failure instead of a fallback (CI uses this).
- `EXXPERTS_INSTALL_METHOD=source` forces the legacy clone-and-build flow.
- `EXXPERTS_DIR` (the clone location) also selects the source flow; the archive path is only chosen by default when it is unset.
- `EXXPERTS_ARCHIVE_URL` and `EXXPERTS_SUMS_URL` override the GitHub release lookup with a direct URL or a local file path (CI points them at archives built in the job). `EXXPERTS_SUMS_URL` only takes effect together with `EXXPERTS_ARCHIVE_URL`; on its own it is ignored.
- Setting both `EXXPERTS_DIR` and `EXXPERTS_INSTALL_METHOD=archive` is a contradiction and a hard error.

Per-push CI coverage of this path lives in `.github/workflows/ci.yml`: the `install-script-archive-linux` and `install-script-archive-windows` jobs install from a locally built archive and assert version, untouched `~/.exxperts`, and `app/.env` survival across a re-run.

## Dry runs without publishing

Trigger the "Release" workflow manually (workflow_dispatch) to run the whole pipeline, including builds and bare-machine smokes, without creating a release. The publish job only runs on tag push events, never on manual runs (even a manual run aimed at a tag ref stays a dry run); the tag-version guard passes as a no-op on manual runs.

## The vendored Node pin

The archives bundle their own Node runtime. Its version is pinned in `scripts/release-node-version.json` (single source of truth; `node scripts/bundle-release.mjs --print-node-version` prints it), together with the sha256 of each per-target nodejs.org archive. The pin file is the trust anchor: `bundle-release.mjs` verifies every downloaded Node archive against the pinned hash and hard-fails on mismatch, instead of trusting whatever checksum file nodejs.org serves at build time.

`scripts/check-node-currency.mjs` compares the pin against the official nodejs.org release index. It fails when a newer release in the same major line is marked as a security release, warns on ordinary newer patches, and fails on a pin that does not exist in the index. The "Node currency" workflow (`.github/workflows/node-currency.yml`) runs it weekly and on changes to the pin or the check itself, and the release workflow runs it before every build.

To bump the pin: edit the version in `scripts/release-node-version.json` and update the three hashes (`win-x64` for `node-v<version>-win-x64.zip`, `darwin-arm64` for `node-v<version>-darwin-arm64.tar.gz`, `linux-x64` for `node-v<version>-linux-x64.tar.xz`) from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`. That checksum file is itself PGP-signed as `SHASUMS256.txt.asc`, so the pinned values can be independently verified against the signed file before the change is approved. Then let CI go green and cut a new release so users actually receive the patched runtime.
