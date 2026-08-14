# Web search

There are two ways a room reaches the web, and which one it uses depends on
the model it runs.

## Provider search (Claude and ChatGPT rooms)

Rooms on the **Claude** and **ChatGPT** profiles search through the provider
itself. The model looks things up while it is answering, on the provider's own
infrastructure, and the results arrive as part of its reply. There is nothing
to install and nothing to configure: it is on by default, and it is already
covered by the subscription those profiles use.

**Subscription sign-ins only.** This applies when you signed in to Claude or
ChatGPT, which is what the subscription covers. If you connected Anthropic with
an **API key** instead, provider-side search is billed separately, per
thousand searches, on top of tokens. Turning that on for you by default would
be spending your money on a choice you never made, so an API-key connection
behaves like any other provider: it keeps the built-in search below, and the
switch above does not apply to it.

**Turning it off.** **AI setup → Web search** has one switch, *Use provider
search where available*. Unticking it stops the app asking either provider to
search, and every room falls back to the built-in search below. That is the
setting for deployments that need every search to happen on their own
infrastructure. It takes effect from the next message, with no restart, in
rooms that are already open.

`EXXETA_SEARCH_PROVIDER` deliberately has **no** say over provider search. That
variable chooses which local backend runs; reading it as "and no provider
search either" would turn a backend choice into a data-governance decision
nobody made. The switch above is the only thing that governs provider search.

**One room, one web search.** Both providers call their own tool `web_search`,
which is also the name of the app's own tool, and sending both in one request
is ambiguous at best. So when a room searches through its provider, the app's
own `web_search` stands down for that room. `fetch_url` is unaffected either
way: opening a page you handed the room is a different job from finding one.

**Privacy note:** the search runs on the provider's infrastructure, so the
model's search terms are handled by the provider under the same agreement as
the rest of the conversation, and by whichever search engine it uses behind
that. Nothing is routed through a search engine of your choosing, and nothing
about the search is visible to this app. That last point has a consequence
worth stating plainly: the app's outbound-argument scanning inspects what a
room's own tools are asked to send, and a provider-side search never passes
through it, so those search terms are not scanned. The guardrail applies to the
built-in search only. If either of these is not acceptable for your data, turn
the switch off and the built-in search below takes over.

Gateway and custom models are not part of this. A gateway model searches
through its gateway only if you marked it as supporting web search when you
approved it; see [`provider-setup.md`](provider-setup.md). Everything else uses
the built-in search.

## Built-in search (everything else)

Web search is **built in**: with no setup, the `web_search` tool queries
DuckDuckGo directly (its plain HTML endpoint; no API key, no account).
DuckDuckGo rate-limits automated queries, and on some networks it blocks
them outright; when that happens the room shows an honest error naming the
block. Which backend runs is a setting in the app, under **AI setup → Web
search**. For heavy use, or on a network where DuckDuckGo blocks searches, a
**local SearXNG container** is the reliable path: it aggregates several
engines and is not subject to DuckDuckGo's limits. When SearXNG is configured it is always preferred;
if it stops answering, searches fall back to the built-in DuckDuckGo backend
until it is back. Setting `EXXETA_SEARCH_PROVIDER=disabled` turns web search
off entirely.

**Privacy note:** either backend sends your search **queries** to a public
search engine (DuckDuckGo directly, or the engines SearXNG aggregates), so
search terms do leave the machine; results and the rest of your data do not.
Avoid searching confidential client/internal content.

### Choosing a backend in the app

Under the provider-search switch, **AI setup → Web search** shows the built-in
choice and lets you change it: DuckDuckGo (the default, nothing to install),
your own SearXNG (with a field for its address), or off. A change applies to
the **next search**; nothing needs restarting, and rooms already in the middle
of a conversation pick it up too.

This choice covers gateway and custom models, and every room whose model does
not search for itself. With provider search switched off it covers the Claude
and ChatGPT rooms too.

The screen and the terminal setup read and write the same file
(`~/.exxperts/app/web-search.json`). The screen can change anything the setup
command wrote; the setup command is deliberately more cautious in return, and
leaves an existing backend choice alone rather than overwriting it (it fills in
only what has not been chosen). If `EXXETA_SEARCH_PROVIDER` is set for the app,
that wins over both for the built-in backend, and the screen says so instead of
showing you a setting that isn't in force.

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

That's it: web search now works in both the web UI and the CLI, however you
launch them. A running app picks the new config up on its next search, so
there is nothing to restart. You can confirm it under **AI setup → Web
search**, which is also where you can switch back to DuckDuckGo or turn
search off.

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
