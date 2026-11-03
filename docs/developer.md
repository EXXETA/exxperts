# Developer guide

Technical guide for working on exxperts from a clone. For user/evaluator setup, see the root [`README.md`](../README.md).

## Repository layout

```text
pi-package/          Extensions, themes, product-state path helpers
runtime/             Owned exxperts runtime packages (the Pi fork)
apps/web-server/     Fastify server: persistent rooms, memory lifecycle, tool policy
apps/web-ui/         React/Vite web UI
scripts/             Repo/dev launchers: exxperts-web; legacy exxeta aliases
bin/                 Packaged bin shim: exxperts (plus a direct-node dev entry point)
docs/                Product, architecture, ops, demo, collaboration docs
```

For the product architecture (rooms, prompt layers, and the memory
lifecycle), start with [`how-exxperts-works.md`](how-exxperts-works.md).

## Developer commands

```bash
npm install
npm run build
./scripts/exxperts-web     # dev web launcher
npm run doctor             # checks the install and the optional layers
```

On Windows PowerShell/cmd, use `node scripts\exxeta-web.mjs` (dev web); the bash launcher above also works from Git Bash.

Provider sign-in and OpenAI-compatible gateways are set up in the app, under **Settings, AI setup**; see [`provider-setup.md`](provider-setup.md).

Do not use the globally installed packaged command to validate current-branch behavior unless you have rebuilt, packed, and installed that branch. Global commands may point at an older packaged product.

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
   ```
   These repo scripts are dev-only fallbacks and continue to work. Packaging cleanup does not make normal product development harder.

2. **Installed product loop**: use this when validating what an evaluator/user will run.
   ```bash
   npm run build
   npm pack
   npm exec --package ./exxeta-exxperts-app-*.tgz -- exxperts --help
   ```
   For a realistic installed-command check, install the tarball globally and verify `which exxperts` and `exxperts --help`.

After code changes, rebuild/repack/reinstall only when you need to test installed behaviour: bin resolution, package-root paths, packaged assets, first-run dirs, or browser opening.

## `npm exec`, global install, and npm prefix

- Use `npm exec --package ./exxeta-exxperts-app-*.tgz -- <command>` for one-off tarball smoke tests without changing your global `PATH`.
- Use `npm install -g ./exxeta-exxperts-app-*.tgz` when you want the normal `exxperts` command available from any shell.
- If global install fails with `EACCES`, configure a user-level npm prefix such as `~/.npm-global`; do not use `sudo` for local product validation.

## Product surfaces

The app (`exxperts`, `./scripts/exxperts-web`, or the desktop app) is the one product surface: persistent rooms and the memory lifecycle. Everything a person sets up, from provider sign-in to connectors, web search and remote access, is in the app's Settings.

## How prompts are assembled

**Persistent rooms (web)** boot from four code-assembled layers (L0
platform kernel, L1a constitution, L1b durable memory, L2 runtime
envelope) built in `apps/web-server/src/persistent-agent-constitution.ts` and
`persistent-agent-boot.ts`, plus the
user's optional instructions layer between L1a and L1b
(`persistent-room-instructions.ts`: the room's file and the global file
under the app's state folder, read and written by the same code;
`composePersistentRoomInstructions`, the ONE composition of the two into
the layer, its fingerprint marker, and the per-turn "Current
instructions" section that carries an edit or a flip of the switch into
an already-open conversation; `persistent-room-global-instructions-setting.ts`:
the per-room switch, absent meaning on;
`persistent-room-instructions-text.ts`: the browser-safe text rules,
normalization, validation, the cap, the marker grammar, shared with
both panes). No Markdown
prompt files are involved; the code is the source of truth. See
[`how-exxperts-works.md`](how-exxperts-works.md) for the layer model.

**Memory lifecycle workers** (checkpoint, shown as “Remember” in the UI; absorb, shown as “Memorize”; the note tidy, shown as “Review”) each carry a
platform-owned constitution defined next to their prompt assembly:
`checkpoint-compression.ts`, `absorb-consolidation.ts`, and
`review-ops.ts` under `apps/web-server/src/`. Review and Memorize are
RUNS: the server walks the room's notes a group at a time
(`review-run.ts`, `absorb-run.ts`), so no single call is asked to
rewrite a whole memory. Workers run as
isolated, tool-less sessions (`persistent-agent-worker-runtime.ts`)
on the room's Memory model (`room-models.ts`), drawn from the models
each provider approves (`persistent-agent-ai-profiles.ts`).

### Room tool boundary

Persistent rooms do not load arbitrary Pi extensions. This is deliberate: the
room surface exposes a reviewed, product-owned tool set under explicit
permission and workspace policies. Rooms do not install anything from the
`packages` list in `settings.json` (old entries stay there, ignored), and run
only the product-owned extension set. Skills reach rooms only
through the skill library: imported in the web app, or placed in
`~/.exxperts/agent/skills` or the shared `~/.agents/skills`, and enabled per
room.

## Local data

Current product/app state lives under `~/.exxperts/app/`, including:

- `personalized-agents/<id>/`: persistent rooms (L1b memory, archives, event records, threads)
- `conversations/`
- `persistent-room-schedules/` and `background-runs/`
- `persistent-agent-ai-profile.json` (the Default models) and `openai-compatible-ai-profile.json` (gateway policy, when configured); each room's Conversation and Memory models live in `personalized-agents/<id>/runtime/models.json`
- `usage.jsonl`
- `agents/`, `skills/`
- `web-search.json` and `searxng/`

Embedded runtime provider/auth/model/session state lives under `~/.exxperts/agent/`, including provider/model registry files and local runtime auth state where applicable.

## Packaging notes

Root package bins:

- `exxperts` → `bin/exxperts.cjs`: starts the local server and opens the app in the browser. The removed terminal commands print that they were removed and exit 1.

This is the only installed command. The other file in `bin/` (`exxperts-web.cjs`) is a direct-node dev entry point (`node bin/exxperts-web.cjs`), not a global command.

The package uses its installed root as `EXXETA_HOME` so packaged agents, extensions, runtime assets, and `apps/web-ui/dist` resolve independently of the caller's cwd.

The embedded runtime package bin is named `exxperts-runtime`; it must not expose `exxperts`, otherwise `npm exec --package <tarball> -- exxperts` may resolve the runtime's own command instead of the product web launcher.

See [`packaging-local.md`](packaging-local.md) for packaging validation commands and current blockers.

## Related docs

- [`how-exxperts-works.md`](how-exxperts-works.md): product architecture: rooms, prompt layers, memory lifecycle.
- [`memory.md`](memory.md): user-facing memory walkthrough.
- [`l1a-constitution-upgrade.md`](l1a-constitution-upgrade.md): constitution versioning/migration.
- [`provider-setup.md`](provider-setup.md): provider setup, and which model a room uses.
- [`mcp.md`](mcp.md)
- Historical extension and collaboration notes live in the development repository's archive and are not part of public releases.
