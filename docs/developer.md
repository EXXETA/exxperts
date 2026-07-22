# Developer guide

Technical guide for working on exxperts from a clone. For user/evaluator setup, see the root [`README.md`](../README.md).

## Repository layout

```text
pi-package/          Extensions, skills, product-state path helpers
runtime/             Owned exxperts runtime packages (the Pi fork)
apps/web-server/     Fastify server: persistent rooms, memory lifecycle, tool policy
apps/web-ui/         React/Vite web UI
scripts/             Repo/dev launchers: exxperts-cli, exxperts-web; legacy exxeta aliases
bin/                 Packaged bin shim: exxperts (plus direct-node dev entry points)
docs/                Product, architecture, ops, demo, collaboration docs
```

For the product architecture (rooms, prompt layers, and the memory
lifecycle), start with [`how-exxperts-works.md`](how-exxperts-works.md).

## Developer commands

```bash
npm install
npm run build
./scripts/exxperts-web     # dev web launcher
./scripts/exxperts-cli     # dev Exxperts CLI/TUI
```

On Windows PowerShell/cmd, use `node scripts\exxeta-web.mjs` (dev web) and `node bin\exxperts-cli.cjs` (CLI/TUI); the bash launchers above also work from Git Bash.

OpenAI-compatible gateway setup from a repo clone uses the matching dev launcher command:

```bash
./scripts/exxperts-cli setup openai-compatible
```

Do not use globally installed packaged commands to validate current-branch setup behavior unless you have rebuilt, packed, and installed that branch. Global commands may point at an older packaged product.

After modifying runtime source:

```bash
cd runtime
npm run build
cd ..
```

## User install vs developer workflow

There are two loops; keep them separate:

1. **Repo development loop**: use this while building features.
   ```bash
   npm install
   npm run build
   ./scripts/exxperts-web
   ./scripts/exxperts-cli
   ```
   These repo scripts are dev-only fallbacks and continue to work. Packaging cleanup does not make normal product development harder.

2. **Installed product loop**: use this when validating what an evaluator/user will run.
   ```bash
   npm run build
   npm pack
   npm exec --package ./exxeta-exxperts-app-*.tgz -- exxperts --help
   npm exec --package ./exxeta-exxperts-app-*.tgz -- exxperts cli --help
   ```
   For a realistic installed-command check, install the tarball globally and verify `which exxperts`, `exxperts --help`, `exxperts web --help`, and `exxperts cli --help`.

After code changes, rebuild/repack/reinstall only when you need to test installed behaviour: bin resolution, package-root paths, packaged assets, first-run dirs, browser opening, or cwd handling from another repo.

## `npm exec`, global install, and npm prefix

- Use `npm exec --package ./exxeta-exxperts-app-*.tgz -- <command>` for one-off tarball smoke tests without changing your global `PATH`.
- Use `npm install -g ./exxeta-exxperts-app-*.tgz` when you want the normal `exxperts` command (`exxperts web`, `exxperts cli`, bare `exxperts` picker) available from any shell.
- If global install fails with `EACCES`, configure a user-level npm prefix such as `~/.npm-global`; do not use `sudo` for local product validation.

`exxperts web --port <port>` and `exxperts web --no-open` are test/debug flags for port conflicts, CI-style checks, and asset validation. They are not the normal user path; normal users run `exxperts web`.

## Product surfaces

- Web (`exxperts web`, `./scripts/exxperts-web`) is the business/user workspace: persistent rooms and the memory lifecycle.
- CLI (`exxperts cli`, `./scripts/exxperts-cli`) is the coding workspace (ExxCode). It preserves the caller cwd so it can inspect/edit the target repo.
- Installed gateway setup should be presented as `exxperts setup openai-compatible`. The repo/development equivalent is `./scripts/exxperts-cli setup openai-compatible`. Keep these loops separate when validating onboarding.

## How prompts are assembled

**Persistent rooms (web)** boot from four code-assembled layers (L0
platform kernel, L1a constitution, L1b durable memory, L2 runtime
envelope) built in `apps/web-server/src/persistent-agents.ts`. No
Markdown prompt files are involved; the code is the source of truth.
See [`how-exxperts-works.md`](how-exxperts-works.md) for the layer
model.

**Memory lifecycle workers** (checkpoint; absorb, shown as “Learn” in the UI; prune/structural review, shown as “Review Memory”) each carry a
platform-owned constitution defined next to their prompt assembly:
`checkpoint-compression.ts`, `absorb-consolidation.ts`, and
`structural-review.ts` under `apps/web-server/src/`. Workers run as
isolated, tool-less sessions (`persistent-agent-worker-runtime.ts`)
with models locked per AI profile
(`persistent-agent-ai-profiles.ts`).

**CLI sessions** use the runtime's resource loader: context files such
as a repo-root `AGENTS.md` are auto-loaded, and extensions in
`pi-package/extensions/*` register tools, gated by the
permissions/content-policy extensions.

### Room tool boundary

Persistent rooms do not load arbitrary Pi extensions. This is deliberate: the
room surface exposes a reviewed, product-owned tool set under explicit
permission and workspace policies. The `exxperts install` command emits a
warning because Pi extensions from any supported source will not be loaded in
persistent rooms for security. Skills can still be installed.
This boundary is part of exxperts' governance model.

## Local data

Current product/app state lives under `~/.exxperts/app/`, including:

- `personalized-agents/<id>/`: persistent rooms (L1b memory, archives, event records, threads)
- `conversations/`
- `persistent-room-schedules/` and `background-runs/`
- `persistent-agent-ai-profile.json` (active AI profile) and `openai-compatible-ai-profile.json` (gateway policy, when configured)
- `usage.jsonl`
- `memory.jsonl` (CLI fact store, created on first use)
- `agents/`, `skills/`
- `web-search.json` and `searxng/`

Embedded runtime provider/auth/model/session state lives under `~/.exxperts/agent/`, including provider/model registry files and local runtime auth state where applicable.

Older alpha/prototype builds used `~/.exxeta/` for product/app state. Treat that as legacy data only if it exists; do not describe it as the current default storage root.

## Packaging notes

Root package bins:

- `exxperts` → `bin/exxperts.cjs` → product router; `exxperts web` starts the web app, `exxperts cli` starts the CLI/TUI, `exxperts setup ...` routes to runtime setup without starting the web server, and bare `exxperts` opens an interactive picker between the two surfaces (web app recommended).

This is the only installed command. The other files in `bin/` (`exxperts-web.cjs`, `exxperts-cli.cjs`, `exxcode.cjs`) are direct-node dev entry points (`node bin/exxperts-web.cjs`), not global commands.

The package uses its installed root as `EXXETA_HOME` so packaged agents, extensions, runtime assets, and `apps/web-ui/dist` resolve independently of the caller's cwd. `exxperts cli` intentionally preserves the caller cwd so ExxCode can inspect/edit the target repo.

The embedded runtime package bin is named `exxperts-runtime`; it must not expose `exxperts`, otherwise `npm exec --package <tarball> -- exxperts` may resolve the runtime TUI instead of the product web launcher.

See [`packaging-local.md`](packaging-local.md) for packaging validation commands and current blockers.

## Related docs

- [`how-exxperts-works.md`](how-exxperts-works.md): product architecture: rooms, prompt layers, memory lifecycle.
- [`memory.md`](memory.md): user-facing memory walkthrough (rooms + CLI).
- [`l1a-constitution-upgrade.md`](l1a-constitution-upgrade.md): constitution versioning/migration.
- [`provider-setup.md`](provider-setup.md): AI profiles and provider setup.
- [`mcp.md`](mcp.md)
- Historical extension and collaboration notes live in the development repository's archive and are not part of public releases.
