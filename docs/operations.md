# Operations

> Audience: whoever runs, deploys, or troubleshoots this. Keep it nearby.

## Prerequisites

- Node.js 20.6+ (we test on 22).
- A model provider configured; see [`provider-setup.md`](provider-setup.md)
  for AI profiles (Claude, ChatGPT Plus/Pro, OpenAI-compatible gateway).
  API keys via `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `.env` or shell
  also work.

## One-time setup

```bash
cd /path/to/exxperts
npm install
npm run build

cp .env.example .env
# edit .env if needed (API keys)
```

`node scripts/doctor.mjs` checks a fresh environment end to end.

## Running

The `./scripts/...` launchers below are bash scripts (macOS/Linux/Git Bash). On Windows PowerShell/cmd, use the shell-independent equivalents: `node scripts\exxeta-web.mjs` (dev web), `node bin\exxperts-web.cjs` (web app), `node bin\exxperts-cli.cjs` (CLI/TUI).

### Web (server + UI together)

```bash
./scripts/exxperts-web
```

Compatibility: `./scripts/exxeta-web` still works today as the older repo/dev alias, but current docs should prefer `./scripts/exxperts-web`.

Behind the scenes:
- Kills any stale processes on `:8787` and `:5173`.
- Starts the web server in the background, logs to
  `.exxperts-cache/web-server.log`.
- Starts Vite in the background, logs to `.exxperts-cache/web-ui.log`.
- Waits for both to respond, opens `http://localhost:5173` in the
  browser.
- Trapped on `Ctrl+C` to stop both cleanly.

The web server binds to `127.0.0.1` only, validates Host/Origin
headers, and requires a client auth token on API and WebSocket
requests (see `SECURITY.md`); it is not reachable from the LAN by design.

### CLI

```bash
./scripts/exxperts-cli
```

Compatibility: `./scripts/exxeta` still works today as the older repo/dev CLI alias. Keep the `EXXETA_*` environment variable names; they remain the current compatibility/internal names for these controls.

The launcher is a thin shim: it sets `EXXETA_HOME`, auto-loads `.env`,
and starts the runtime CLI/TUI with the exxperts extension set. It
preserves the caller cwd so coding sessions can inspect/edit the target
repo.

## API usage and model settings

exxperts does **not** call OpenAI / Anthropic directly for normal chat turns.
The CLI wrapper and the web server both hand the conversation to the
underlying runtime, which owns provider auth, model transport,
streaming, usage accounting, and default generation parameters.

Where API calls happen:

| Path | What calls APIs |
|---|---|
| Web room chat | `apps/web-server/src/index.ts` creates a runtime agent session; the runtime calls the selected LLM provider. |
| CLI chat | `bin/exxperts-cli.cjs` starts the runtime CLI with the exxperts extensions. |
| Memory lifecycle workers | Checkpoint, Learn, and Review Memory proposals each run an isolated, tool-less worker session (`apps/web-server/src/persistent-agent-worker-runtime.ts`). |
| Scheduled room runs | Background schedule execution runs room turns headlessly. |

Model selection is owned by the active **AI profile**: rooms pick from
the profile's room-model list, checkpoint workers inherit the room's
model, and Learn/Review Memory use the profile's maintenance model
(`apps/web-server/src/persistent-agent-ai-profiles.ts`). See
[`provider-setup.md`](provider-setup.md).

Temperature is **not configured in exxperts today**. Generation behaviour
comes from the runtime/provider defaults for the selected model.

## Environment variables

All of these can go in `.env` (auto-loaded) or your shell.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Set if not using subscription auth. |
| `OPENAI_API_KEY` | (none) | Same. |
| `EXXETA_KB_VAULTS` | (none) | Optional override/additional Markdown vault config for the knowledge tools. Primary persistent config is `~/.exxperts/app/kb-vaults.json`. |
| `EXXETA_SEARCH_PROVIDER` | `disabled` | Web search provider: `disabled` or `searxng`. |
| `EXXETA_SEARCH_BASE_URL` | (none) | Required when `EXXETA_SEARCH_PROVIDER=searxng`, for example `http://127.0.0.1:8888`. Start a local instance with `./scripts/searxng start`. |
| `PORT` | `8787` | Web server port. |

## Local SearXNG

For CLI/web research without a paid search API, start Docker and run a local SearXNG container:

```bash
./scripts/searxng start        # macOS / Linux / Git Bash
node scripts\searxng.mjs start # Windows (PowerShell or cmd)
```

The helper writes `~/.exxperts/app/web-search.json` if no web-search config exists yet. Equivalent `.env` overrides are:

```bash
EXXETA_SEARCH_PROVIDER=searxng
EXXETA_SEARCH_BASE_URL=http://127.0.0.1:8888
```

The helper writes generated SearXNG settings to `~/.exxperts/app/searxng/settings.yml` with SearXNG JSON output enabled because `web_search` calls `/search?format=json`. Full reference: [`web-search.md`](web-search.md).

## Ports

| Port | Service |
|---|---|
| `5173` | Vite dev server (web UI). |
| `8787` | Fastify web server. Exposes `/healthz`, `/api/*`, `/ws`. Loopback only. |

## Logs

| File | What |
|---|---|
| `.exxperts-cache/web-server.log` | Fastify pino logs, request/response, extension probes. |
| `.exxperts-cache/web-ui.log` | Vite output. |

## Storage layout

| Path | What | Persists across reinstalls? |
|---|---|---|
| `~/.exxperts/app/personalized-agents/<id>/` | Persistent rooms: L1b memory, archives, event records, threads, per-room settings | yes |
| `~/.exxperts/app/conversations/` | Web conversation metadata + transcripts | yes |
| `~/.exxperts/app/persistent-room-schedules/` | Room schedule definitions | yes |
| `~/.exxperts/app/background-runs/` | Scheduled-run history | yes |
| `~/.exxperts/app/persistent-agent-ai-profile.json` | Active AI profile selection | yes |
| `~/.exxperts/app/openai-compatible-ai-profile.json` | Gateway profile policy, when configured | yes |
| `~/.exxperts/app/usage.jsonl` | Token/cost log | yes |
| `~/.exxperts/app/memory.jsonl` | CLI long-term fact store (created on first use) | yes |
| `~/.exxperts/app/agents/`, `~/.exxperts/app/skills/` | User-created agents/skills | yes |
| `~/.exxperts/app/artifacts/` | Approved artifacts (created on first use) | yes |
| `~/.exxperts/app/kb-vaults.json` | Knowledge-vault config (created on first use) | yes |
| `~/.exxperts/app/content-policy.json` | Content policy config | yes |
| `~/.exxperts/app/web-search.json` | Web-search provider config | yes |
| `~/.exxperts/app/searxng/settings.yml` | Generated local SearXNG settings | yes |
| `~/.exxperts/agent/mcp.json` | MCP server config (also `~/.config/mcp/mcp.json`, project `.mcp.json`) | yes |
| `~/.exxperts/agent/` | Embedded runtime provider/auth/model/session state | yes |
| `~/.exxeta/` | Legacy alpha/prototype product state only, if present | yes (legacy) |
| `.exxperts-cache/*.log` | Dev process logs | no (gitignored) |
| `.exxeta-cache/` | Legacy local cache only, if present | no (gitignored) |

## Troubleshooting

### Port already in use

```bash
lsof -ti:8787 | xargs kill -9
lsof -ti:5173 | xargs kill -9
```

`scripts/exxperts-web` does this automatically on start. `scripts/exxeta-web` remains an older compatibility alias.

### Browser shows blank page

Check `.exxperts-cache/web-ui.log` for a Vite compile error. Usually a
bad import path. Run `cd apps/web-ui && npm run build` to surface it.

### A room refuses to run or checkpoint

Room and worker models are locked to the active AI profile. If the
profile changed since the room was created, the UI names the expected
model; see [`provider-setup.md`](provider-setup.md).

## Health checks

```bash
curl -fsS http://localhost:8787/healthz
```

## Stopping everything

```bash
lsof -ti:8787 -ti:5173 | xargs kill -9 2>/dev/null
```

Or kill the launcher PID printed by `scripts/exxperts-web`.

## Backups

What's worth backing up:

- `~/.exxperts/app/`: product/app state, meaning persistent rooms (memory, archives, event records), conversations, schedules, usage, KB/MCP/search config.
- `~/.exxperts/agent/`: embedded runtime provider/auth/model/session state, including local provider credentials where applicable.
- `~/.exxeta/`: legacy alpha/prototype product state only if you still have data there.
- The repo (use git).
- `.env`: secrets (don't commit).

Not worth backing up: `.exxperts-cache/` (dev logs), legacy `.exxeta-cache/` contents, `node_modules/`.
