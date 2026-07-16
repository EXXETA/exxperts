# Local npm packaging

Thin local package path for validation. This is not a final native installer.

Use this document for detailed tarball checks. For day-to-day feature work, use the repo development loop in [`developer.md`](developer.md); rebuild/repack/reinstall only when validating installed-product behaviour.

## Installed product loop vs repo development loop

- **Installed product loop:** `npm run build` → `npm pack` → `npm exec --package <tarball> -- exxperts web` or `npm install -g <tarball>` → `exxperts web` for the web app, `exxperts cli` for the coding CLI/TUI. Plain `exxperts` opens an interactive picker between the two surfaces.
- **Installed gateway provider setup:** `exxperts setup openai-compatible`.
- **Repo development loop:** clone → `npm install` → `npm run build` → `./scripts/exxperts-web` / `./scripts/exxperts-cli`.
- **Repo gateway provider setup:** `./scripts/exxperts-cli setup openai-compatible`.
- Package commands validate user launch, bin resolution, packaged assets, package-root paths, setup-command routing, and current-repo cwd handling for `exxperts cli`.
- Older `./scripts/exxeta-web` and `./scripts/exxeta` repo scripts remain compatibility aliases, but current docs should prefer the explicit Exxperts commands.

## Build and pack

```bash
npm install
npm run build
npm pack
```

This creates a tarball like:

```bash
exxeta-exxperts-app-0.6.0-f6.0.tgz
```

## Preferred local run: npm exec

Use `npm exec` when you want to test the tarball once without installing commands globally or changing your `PATH`:

```bash
# Web workspace
npm exec --package ./exxeta-exxperts-app-0.6.0-f6.0.tgz -- exxperts web

# Help and setup checks
npm exec --package ./exxeta-exxperts-app-0.6.0-f6.0.tgz -- exxperts --help
npm exec --package ./exxeta-exxperts-app-0.6.0-f6.0.tgz -- exxperts setup --help
npm exec --package ./exxeta-exxperts-app-0.6.0-f6.0.tgz -- exxperts cli --help

# Coding CLI/TUI from any repo
cd /path/to/any/repo
npm exec --package /absolute/path/to/exxeta-exxperts-app-0.6.0-f6.0.tgz -- exxperts cli
```

## Optional global install

Use global install when you want to validate the real installed user commands from any shell:

```bash
npm install -g ./exxeta-exxperts-app-0.6.0-f6.0.tgz
which exxperts
exxperts web   # packaged web app
exxperts cli   # packaged CLI/TUI from the current directory
exxperts       # interactive picker between the two surfaces
```

If macOS returns `EACCES`, do not use `sudo` for this local product install. Configure a user-level npm prefix:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g ./exxeta-exxperts-app-0.6.0-f6.0.tgz
```

For bash, write the PATH line to `~/.bashrc` or `~/.bash_profile` instead.

Already ran the install with `sudo`? Undo it first, or the next update fails with new permission errors (root-owned files in the global folder, the npm cache, and your clone):

```bash
sudo npm uninstall -g @exxeta/exxperts-app
sudo chown -R $(whoami) ~/.npm
sudo chown -R $(whoami) .    # run inside your exxperts clone
```

Then apply the user-level prefix steps above and reinstall.

Uninstall later:

```bash
npm uninstall -g @exxeta/exxperts-app
```

## What the package does

- exposes a single npm bin: `exxperts`
- `exxperts web` starts the local Fastify server, serves `apps/web-ui/dist`, and opens the browser unless `--no-open` is set
- `exxperts cli` starts the packaged CLI/TUI directly from Node and preserves the caller's cwd for repo work
- plain `exxperts` opens an interactive picker between the two surfaces (web app recommended)
- `exxperts setup openai-compatible` routes directly to the runtime setup command without starting the web server
- sets `EXXETA_HOME` to the installed package root for bundled agents, skills, extensions, themes, runtime assets, and static web UI files
- creates first-run user dirs as needed under `~/.exxperts/app`, including `~/.exxperts/app/agents` and `~/.exxperts/app/skills`
- keeps user-created agents, skills, memory, usage, conversations, MCP config, policy config, and artifacts under `~/.exxperts/app`

Static web assets are served from the packaged Vite dist:

- `/assets/*`: JS/CSS bundles
- `/brand/*`: logo files
- `/fonts/*`: local font files copied from `apps/web-ui/public`

## Bin collision guard

The product package owns the public `exxperts` bin. The embedded runtime package must expose only `exxperts-runtime`; otherwise `npm exec --package <tarball> -- exxperts ...` can resolve the embedded runtime package instead of the product launcher/router.

## Validation checklist

```bash
npm run build
npm pack --dry-run --json
npm pack
npm exec --package ./exxeta-exxperts-app-*.tgz -- exxperts --help
npm exec --package ./exxeta-exxperts-app-*.tgz -- exxperts setup --help
npm exec --package ./exxeta-exxperts-app-*.tgz -- exxperts cli --help
npm exec --package ./exxeta-exxperts-app-*.tgz -- exxperts web --no-open --port 8790
```

`--port` and `--no-open` are test/debug flags for scripted web checks, port conflicts, and asset validation. For normal web launches, use `exxperts web`.

While the web server is running, check assets:

```bash
curl -I http://localhost:8790/
curl -I http://localhost:8790/brand/exxperts-logo.png
curl -I http://localhost:8790/fonts/Sen-Regular.ttf
curl -I http://localhost:8790/fonts/BandeinsStrange-Bold.otf
```

Expected: HTTP 200 with `text/html`, `image/png`, `font/ttf`, and `font/otf` content types respectively.

## Current scope

Implemented for local npm tarball smoke testing only:

- cross-platform Node launchers for macOS/Windows/Linux browser opening
- package-root path resolution via `EXXETA_HOME`
- packaged static web UI serving, including logo and fonts
- product command split: `exxperts web` for the web app, `exxperts cli` for the packaged CLI/TUI, and bare `exxperts` opening the interactive surface picker (the single installed command)

Not included: Electron/Tauri, Docker, native installer, DMG/MSI, notarisation, icons, auto-update, or publishing automation.

## Prebuilt release archives (phase 0)

`scripts/bundle-release.mjs` produces a self-contained per-OS archive so end users need neither Node nor npm to run exxperts. It builds and packs the repo, installs the tarball into a temporary npm prefix (the same pipeline as `install:global`, including the npm allow flags and the postinstall replay), then stages and compresses:

```
exxperts/
  exxperts          POSIX launcher shim (exxperts.cmd on Windows)
  app/              the installed package tree, prod deps included, no symlinks
  vendor/node/      pinned Node runtime (bin/node plus LICENSE; node.exe on Windows)
```

The shim runs `vendor/node/bin/node app/bin/exxperts.cjs`, and because the launcher chain spawns all children via its own `process.execPath`, everything downstream (tsx, the web server, the CLI runtime) uses the vendored Node. The Node version is pinned in `scripts/release-node-version.json` together with the per-target sha256 of the nodejs.org archive (checked weekly by `scripts/check-node-currency.mjs`), and the download is verified against that pinned hash.

Deliberately not bundled: Chromium (a per-user cache download, fetched later with `npx playwright install chromium`; artifact preview degrades gracefully without it) and git (a soft dependency, only needed for the skills-repo fetch). The `.env` file is read from `app/.env` inside the unpacked archive, so provider configuration travels with the install location, not the archive.

Targets must be built on a matching host (native deps like esbuild install only the host platform's binary): `win-x64`, `darwin-arm64`, `linux-x64`.

Build and smoke locally:

```bash
node scripts/bundle-release.mjs --target darwin-arm64 --out dist-release
node scripts/smoke-release-archive.mjs dist-release/exxperts-<version>-darwin-arm64.tar.gz
```

The smoke unpacks the archive to a temp dir and runs it with a sanitized environment (system-dirs-only PATH, temp HOME) to prove no system Node, npm or git is needed: it asserts `exxperts --version`, boots the web server with `--no-open` on a free port, asserts HTTP on `/healthz` and `/`, and tears the process tree down.

## Known blockers before final packaging

- The package still runs TypeScript server sources through `tsx`; a final package should build `apps/web-server` to JS.
- Local workspace runtime packages are consumed via `file:` dependencies; npm registry publishing needs either published `@exxeta/exxperts-*` packages or a bundling step that vendors them cleanly.
- Font redistribution/licensing must be confirmed before external delivery.
