<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/exxperts-logo-negative.png">
    <img src="docs/assets/exxperts-logo.png" alt="exxperts" width="360" align="center" />
  </picture>
</div>

<h3 align="center">Your AI's memory. On your machine, under your control.</h3>

<p align="center">
  <a href="https://github.com/EXXETA/exxperts/actions/workflows/ci.yml"><img src="https://github.com/EXXETA/exxperts/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue" alt="License: PolyForm Noncommercial" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520.6-brightgreen" alt="Node.js 20.6+" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="macOS, Windows, Linux" />
</p>

<p align="center">
  exxperts gives you persistent AI rooms with governed, approval-gated memory: agents that remember you and your work across sessions, with every memory write approved by you. Everything runs and stays local: rooms, memory, knowledge base, artifacts, and usage data are files on your disk.
</p>

![The exxperts launcher: seven persistent rooms from Project: Atlas launch to Trip: Japan 2026 and Family admin, each with its own governed memory](docs/assets/exxperts-rooms.png)

## Why exxperts

- **Memory you govern.** Rooms remember decisions, preferences, and context across sessions, but every memory write goes through an approval gate you control. No silent profile-building.
- **Local-first, verifiably.** Rooms, memories, knowledge base, artifacts, and token usage live as plain files under `~/.exxperts`. You can read, back up, or delete all of it. There is no telemetry: the only network traffic is what you use, meaning calls to your model provider, web research if you enable it, and any MCP connectors you add.
- **An agentic runtime, not a chat wrapper.** Rooms use curated tools (knowledge base, artifacts, local web research, MCP connectors) under a permission model scoped to each surface. Rooms never get an unrestricted shell.
- **One product, two surfaces.** The web app and the CLI/TUI share the same rooms, memory, and credential store; switch between them freely.

If you know [Open WebUI](https://github.com/open-webui/open-webui) or [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm): those are excellent local chat/RAG frontends. exxperts is a different shape: a local agentic runtime focused on persistent, governed memory and auditable agent behaviour, not chat over your documents.

![A persistent room researching local AI serving: web searches and the official docs appear as source chips above distilled notes](docs/assets/exxperts-room.png)

![The approval gate: a checkpoint proposal shows exactly what the room will remember, and nothing is saved until you approve it](docs/assets/exxperts-checkpoint.png)

## One product, two surfaces

| Surface | Launch | What you get |
| --- | --- | --- |
| **Web app** | `exxperts web` | Rooms with memory, KB, artifacts, web research, approvals, and the wallet. |
| **CLI / TUI** | `exxperts cli` | The same rooms in your terminal, run from the folder you want as the workspace. |

<p align="center">
  <img src="docs/assets/exxperts-cli.png" alt="The exxperts CLI room picker" width="700" />
</p>

The web app is the full product: AI setup, memory review and approvals, the wallet, connectors, and skills all live there. The CLI/TUI focuses on the rooms themselves. Bare `exxperts` opens a picker for the two surfaces (web app recommended). Product/app state stays local under `~/.exxperts/app` (`%USERPROFILE%\.exxperts` on Windows); embedded runtime provider/auth/model/session state lives under `~/.exxperts/agent`.

## Product capabilities

- Local web workspace with landing page, persistent rooms, approvals, and wallet.
- Rooms-only CLI/TUI sharing the same room runtime and governance.
- Skills page in the web app: write a skill, upload .md/.zip/.skill files, or import from a repo, review before accepting, then enable per room.
- Room-to-room consult: @-mention another room in chat to ask it a question; it answers read-only from its own memory and context.
- Delegated tasks shown as task cards in chat, with artifacts viewable in a sandboxed artifacts viewer.
- Approval-gated memory, KB writes, and Markdown/HTML artifacts.
- Markdown/Obsidian KB tools and local web search.
- MCP connectors on web and CLI through a single proxy tool. Bring your own servers; see [`docs/mcp.md`](docs/mcp.md).
- Local token/cost wallet from `~/.exxperts/app/usage.jsonl`.

![The Connectors page: a verified MCP directory with one-click OAuth logins, shared between the web app and the CLI](docs/assets/exxperts-connectors.png)

## Quick start

Prerequisites: [git](https://git-scm.com) and [Node.js](https://nodejs.org) 20.6+ with npm (on Windows, [Git for Windows](https://gitforwindows.org) 2.40+). One command installs everything:

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/EXXETA/exxperts/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/EXXETA/exxperts/main/install.ps1 | iex
```

The installer checks prerequisites, clones the repo into `~/exxperts` (pick another spot with the `EXXPERTS_DIR` environment variable), and builds and installs the `exxperts` command. Re-run the same command anytime to update.

Prefer to do it by hand? It is three commands. **On Windows, apply the two Git settings from the [Windows quickstart](#windows-quickstart) before cloning** (the one-line installer applies them to its clone for you):

```bash
git clone https://github.com/EXXETA/exxperts.git
cd exxperts
npm install
npm run install:global   # builds, packs, and installs the exxperts commands (all platforms)
```

Two things to expect: `npm install` also fetches headless Chromium (~150 MB, one-time; skip it with `EXXETA_SKIP_BROWSER_INSTALL=1 npm install`), and `install:global` builds the whole app before installing `@exxeta/exxperts-app` into your global npm prefix, so give it a few minutes.

Then, from any shell:

```bash
exxperts web   # the web app: rooms, memory, wallet (current folder does not matter)

cd /path/to/your/project
exxperts cli   # the same rooms in your terminal, with this folder as the workspace
```

First run: open **AI setup** in the web app and sign in to your provider (Claude and ChatGPT subscriptions sign in with one click; API keys and OpenAI-compatible gateways also work; see [Model/provider setup](#modelprovider-setup)). Something not working? `npm run doctor` from the repo root checks every layer and prints the fix.

New here? [`docs/quickstart.md`](docs/quickstart.md) walks the whole path in about five minutes: install, connect your AI, first room, first memory. For an orientation on what the product is and how the pieces fit, read [`docs/how-exxperts-works.md`](docs/how-exxperts-works.md).

### Updating

Re-run the one-line install command from the quick start; it pulls the latest version and reinstalls. Or manually, same on every platform, from the repo folder:

```bash
git pull
npm install              # in case dependencies changed
npm run install:global   # rebuilds and reinstalls the global commands
```

The global `exxperts` commands then run the new version. If anything misbehaves after an update, or anytime, run `npm run doctor` from the repo folder. Developing from the clone instead of the global install? Update with `git pull && npm install && npm run build`.

## Windows quickstart

Windows is supported for both the web app and the CLI/TUI. Requirements:

1. **Git for Windows ≥ 2.40** (https://gitforwindows.org). **Git Bash is required**: the agent's shell tool runs commands through `bash.exe`, which is discovered automatically in the standard Git for Windows install location (`C:\Program Files\Git\bin\bash.exe`) or on `PATH`.
2. **Node.js 20.6+ (LTS recommended) and npm** (https://nodejs.org).
3. **Windows Terminal** recommended for the CLI/TUI (legacy conhost is untested).

One-time Git settings before cloning (long paths matter because `node_modules` trees exceed the 260-character `MAX_PATH`):

```powershell
git config --global core.longpaths true
git config --global core.autocrlf false   # the repo's .gitattributes manages line endings
```

Then install from PowerShell or Git Bash, with the same commands as everywhere else. Clone into a folder your user owns (for example under `%USERPROFILE%`, like `C:\Users\you\exxperts`) — cloning into `C:\` or `C:\Program Files` leads to permission errors:

```powershell
cd $env:USERPROFILE
git clone https://github.com/EXXETA/exxperts.git
cd exxperts
npm install
npm run install:global
```

And run from any shell:

```powershell
exxperts web   # web app
exxperts cli   # CLI/TUI, run from the folder you want as workspace
```

Web search works on Windows too: install Docker Desktop, then run `node scripts\searxng.mjs start` once from any shell. See [`docs/web-search.md`](docs/web-search.md).

Developing from the clone without a global install? Use the shell-independent forms: `node bin\exxperts-web.cjs`, `node bin\exxperts-cli.cjs`, and `node scripts\exxeta-web.mjs` (dev web app with server + Vite UI). The bash launchers in `scripts/` also work from Git Bash.

## What to install for full functionality

Everything runs locally. Full functionality is four layers; only the first is required:

1. **Core app**: Node.js 20.6+ and npm, then the quick-start steps above.
2. **Headless Chromium (~150 MB, one-time)**: downloaded automatically during `npm install`; lets rooms visually review the HTML decks they author and read JavaScript-rendered pages. If the download couldn't run, enable it later with `npx playwright install chromium` (or skip it during install with `EXXETA_SKIP_BROWSER_INSTALL=1 npm install`).
3. **Web search**: a container engine plus a one-time setup command. See [Web search (optional)](#web-search-optional).
4. **Model authentication**: provider sign-in or API keys. See [Model/provider setup](#modelprovider-setup).

**Verify any setup with `npm run doctor`** from the repo root: it checks all of the above, plus MCP config and that outbound web fetches decode cleanly (corporate TLS-inspection proxies can corrupt responses), and prints the fix for anything missing.

`install:global` wraps `npm run build && npm pack && npm install -g <tarball>`; the manual steps and one-off runs via `npm exec` (no global install) are documented in [`docs/packaging-local.md`](docs/packaging-local.md). If macOS returns `EACCES`, use a user-level npm prefix instead of `sudo`; that is also covered there. npm 12 is supported out of the box: `package.json` carries the `allowScripts` approvals and a committed `.npmrc` allows the SheetJS CDN tarball dependency, so installs need no extra flags. On npm 11.11+ a harmless `Unknown project config` line may print during install. If the Chromium download was ever skipped, recover it anytime with `npx playwright install chromium`.

## Web search (optional)

Web search ships **disabled** and runs fully locally through a SearXNG container: no API key, no third-party search SaaS. Note: your search **queries** still go to public search engines, so avoid searching confidential client or internal content.

To enable: install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or (lighter on macOS) [OrbStack](https://orbstack.dev), then from the repo directory run the one-time setup command and restart the app:

```bash
./scripts/searxng start        # macOS / Linux / Git Bash
node scripts\searxng.mjs start # Windows (PowerShell or cmd)
```

Setup details, keeping it running across reboots, status/stop commands, and Windows notes: [`docs/web-search.md`](docs/web-search.md).

## Model/provider setup

Rooms need a signed-in model provider before they can respond. Pick whichever path fits.

For subscription providers (Claude, ChatGPT Plus/Pro), launch the web app, open **AI setup**, and use the **Sign in →** button on the provider's profile card. The provider login opens in the browser, and credentials stay in the local credential store.

For an OpenAI-compatible gateway (a company LiteLLM or vLLM proxy, for example), everything happens in the web app: open **AI setup** → **Add another provider** → **Set up gateway**, enter the base URL and the model ids your gateway routes, pick the Learn/Review Memory model, then paste your token on the gateway's profile row. The terminal wizard still works if you prefer it:

```bash
exxperts web
exxperts setup openai-compatible
```

When running from a repo clone, use the matching dev setup command instead of any globally installed command:

```bash
./scripts/exxperts-web
./scripts/exxperts-cli setup openai-compatible
```

Any other provider the runtime knows (Google Gemini, Groq, Mistral, DeepSeek, OpenRouter, xAI, and ~25 more) can be added from the web app: open **AI setup** and use **Add another provider**, then sign in with a subscription where the provider offers one, or paste an API key. After signing in, approve the models that provider may use: the models available in rooms, plus the one that runs Learn and Review Memory (a default is suggested). Approval creates the provider's AI profile; without it, the provider is signed in but not usable in rooms.

Provider API keys in your shell or repo `.env` also work when running from the clone:

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

Subscription/OAuth login also works from the terminal: run `exxperts cli`, then type `/login`. It offers the same provider list as the web app, including API-key entry. The web app and CLI/TUI share the same local runtime credential store, so either path signs in both. Approving models for a newly added provider happens in the web app's **AI setup**.

## Develop from the repo

```bash
npm install
npm run build
npm run doctor          # verify the setup
./scripts/exxperts-web  # dev web app from this clone
./scripts/exxperts-cli  # dev Exxperts CLI/TUI from this clone
```

Packaging does not change normal development. Keep using the repo scripts while editing code; repack/reinstall (`npm run install:global`) only to validate installed-product behaviour. On Windows, use the `node` equivalents from the [Windows quickstart](#windows-quickstart).

## Current limitations

- Distributed as an npm package built from the repo; no native installer yet.
- No hosted multi-user/SSO/RBAC version yet; exxperts is a single-user, local product today.

## More docs

- [`docs/README.md`](docs/README.md): canonical documentation index with audience and status labels.
- [`docs/quickstart.md`](docs/quickstart.md): install, connect, first room, first memory.
- [`docs/how-exxperts-works.md`](docs/how-exxperts-works.md): what the product is and how the pieces fit.
- [`docs/developer.md`](docs/developer.md): developer architecture and repo guide.
- [`docs/web-search.md`](docs/web-search.md): web search setup and operations.
- [`docs/mcp.md`](docs/mcp.md): MCP connectors, with transports, config locations, and commands.
- [`docs/packaging-local.md`](docs/packaging-local.md): local npm package validation.
- [`CHANGELOG.md`](CHANGELOG.md): public-facing changelog.

## Team

exxperts is designed and built by **Borja Odriozola Schick** ([@borcho23](https://github.com/borcho23)) and **Fernando Pastor Alonso** ([@ferpastoralonso](https://github.com/ferpastoralonso)) at [Exxeta](https://exxeta.com), from the memory-engine architecture at its core to the product around it.

exxperts is built on [Pi](https://github.com/badlogic/pi-mono) by Mario Zechner.

Contact: borja.odriozola.schick@exxeta.ch · fernando.pastor@exxeta.ch

## Contributing

Issues and pull requests are welcome; [`CONTRIBUTING.md`](CONTRIBUTING.md) has the full guide (setup, smoke suite, and how PRs get merged). Before reporting a problem, run `npm run doctor` from the repo root and include its output; it often names the fix. For an orientation to the codebase, start with [`docs/developer.md`](docs/developer.md).

## License

exxperts is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE): free to use, modify, and redistribute for any noncommercial purpose. Commercial use requires a separate license; contact Exxeta.

The bundled runtime under `runtime/` is derived from the open-source Pi project (v0.70.5, MIT); the upstream license is preserved in [`runtime/LICENSE`](runtime/LICENSE) and the fork is documented in [`runtime/NOTICE.md`](runtime/NOTICE.md).

Third-party product names and logos in the connector directory are trademarks of their respective owners (glyphs from [Simple Icons](https://simpleicons.org), CC0), used for identification only and not covered by this repository's licence.
