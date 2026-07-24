# Web search

Web search is **built in**: with no setup, the `web_search` tool queries
DuckDuckGo directly (its plain HTML endpoint; no API key, no account).
DuckDuckGo rate-limits automated queries, and on some networks it blocks
them outright; when that happens the room shows an honest error naming the
block. For heavy use, or on a network where DuckDuckGo blocks searches, a
**local SearXNG container** is the reliable path: it aggregates several
engines and is not subject to DuckDuckGo's limits. When SearXNG is configured it is always preferred;
if it stops answering, searches fall back to the built-in DuckDuckGo backend
until it is back. Setting `EXXETA_SEARCH_PROVIDER=disabled` turns web search
off entirely.

**Privacy note:** either backend sends your search **queries** to a public
search engine (DuckDuckGo directly, or the engines SearXNG aggregates), so
search terms do leave the machine; results and the rest of your data do not.
Avoid searching confidential client/internal content.

The rest of this page covers the optional SearXNG setup. The standard way to
turn it on, on any install type, is `exxperts setup search`; the setup below
walks through it, with the script-level detail for developers working from a
clone.

## Setup (optional SearXNG)

1. **Install a container engine** (one-time, like installing Node; it can't
   be bundled). Get [Docker Desktop](https://www.docker.com/products/docker-desktop/)
   (macOS/Windows/Linux) or, lighter on macOS, [OrbStack](https://orbstack.dev).
   Open it so it's running, and set it to **start at login** so search keeps
   working after reboots.
2. **Open a new terminal** (so the freshly installed `docker` is found), then
   run the setup command; it works on every install type. This starts SearXNG
   *and* writes the config for you (to `~/.exxperts/app/web-search.json`,
   which both the `exxperts` command and the repo scripts read):
   ```bash
   exxperts setup search
   ```
   Developers working from a repo clone can call the underlying script
   directly instead: `./scripts/searxng start` (macOS / Linux / Git Bash) or
   `node scripts\searxng.mjs start` (Windows, PowerShell or cmd).
3. **Restart the app** (`exxperts web`, `exxperts cli`, `./scripts/exxperts-web`,
   or `./scripts/exxperts-cli`).

That's it: web search now works in both the web UI and the CLI, however you
launch them.

## How it works (and keeping it running)

SearXNG runs **inside a container**, and a container only runs while its
engine (OrbStack or Docker Desktop) is running. So the rule is simple:

- **Engine running → search works. Engine quit → search stops.**

You do **not** need a terminal open or to keep clicking anything; the engine
is a quiet background/menu-bar app. You just need it alive. To make this
effortless:

- **Turn on "Start at login"** in OrbStack/Docker settings. Then after any
  reboot the engine starts automatically, and our container is set to
  **restart with it** (`--restart unless-stopped`), so search comes back on
  its own, no command needed.

The only time search stops is if the engine is **not running** (someone quit
it, or it isn't set to start at login). You'll see an error like *"SearXNG is
not reachable at http://127.0.0.1:8888."* The fix:

```bash
open -a OrbStack              # macOS (or open Docker Desktop, on any platform)
exxperts setup search status  # check state: running / stopped / docker unavailable
```

Other commands: `exxperts setup search stop` and `exxperts setup search start`
(the default when no subcommand is given). The setup command never overwrites
an existing config, so re-running `start` is always safe. `exxperts doctor`
also checks reachability.

**From a repo clone.** The underlying helper is cross-platform Node:
`./scripts/searxng <start|stop|restart|status>` from macOS / Linux / Git Bash,
or `node scripts\searxng.mjs <start|stop|restart|status>` from PowerShell,
cmd, or Git Bash on Windows. (Docker Desktop with the WSL2 backend works well
on Windows.)

## Configuration reference

The helper writes `~/.exxperts/app/web-search.json` if no web-search config
exists yet, plus generated SearXNG settings to
`~/.exxperts/app/searxng/settings.yml` (JSON output enabled, because
`web_search` calls `/search?format=json`). Environment variables override the
shared config; see [`operations.md`](operations.md) for `EXXETA_SEARCH_*`.
