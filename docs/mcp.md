# MCP client support

exxperts connects to MCP servers through the `mcp` extension, which is
backed by [pi-mcp-adapter](https://pi.dev/packages/pi-mcp-adapter).

## Transports

- **stdio** — local servers spawned as subprocesses.
- **HTTP** — remote servers over StreamableHTTP, with SSE fallback.
- **OAuth** — servers requiring browser login (`bearer` tokens or full
  OAuth flows). On the CLI, press `l` on a connector in the `/mcp`
  panel to log in.

## Config

Servers are read from these files, merged in precedence order:

1. `~/.config/mcp/mcp.json` — shared user-global config (same file other
   MCP-capable tools use)
2. `~/.exxperts/agent/mcp.json` — exxperts user-global config
3. `.mcp.json` — project-local
4. `.pi/mcp.json` — project override

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/root"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
```

On the CLI, `/mcp` opens the exxperts connectors panel
(`pi-package/extensions/mcp/connectors-panel.ts`) — the same disk-backed
view, catalog, and status language as the web Connectors page: per
server it shows the cached tool list (expand with ⏎, open a tool for
its full description), login state, and offers add from the verified
catalog or custom (`a`), remove (`x`), log in/out (`l`/`o`), and a
connection test (`t`). It warns when the config on disk has changed
since the room was opened (rooms load connector config once, at entry).
`s` (or `/mcp setup`) opens the guided setup, which can import existing
MCP configs from Cursor, Claude Code, or Claude Desktop; `/mcp
reconnect` and `/mcp tools` manage the running session's connections.

The previous config location, `~/.exxperts/app/mcp.json`, is no longer
read — move server entries into one of the files above.

In the web app, the **Connectors** page (sidebar, under Tools) shows the
same merged server list — each server's transport, which config file it
came from, its cached tools, and OAuth credential state — and manages it:
add/remove servers (saved to the exxperts user config), test a
connection, and run OAuth logins (the login opens a browser on this
machine, since the server runs locally). Backed by `GET /api/mcp/status`
and the `/api/mcp/servers` routes. Because sessions read MCP config at
session start, changes apply the next time a room is entered or resumed.

The page also includes a **directory** of verified connectors
(`apps/web-ui/src/connector-catalog.ts`): open servers that work with no
login, one-click OAuth servers (dynamic client registration verified),
token-based servers (GitHub — paste an API token once), OAuth-app servers
(HubSpot — create an app in the provider's developer settings, then the
card opens the custom form with the Custom OAuth client fields prefilled),
and guided entries for providers that require your own credentials.

Providers whose auth servers do not support dynamic client registration
(HubSpot is one; most enterprise identity providers are configured this
way) fail the one-click login with "does not support dynamic client
registration". For those, create an app in the provider's developer
settings with the redirect URL `http://localhost:19876/callback`, then
add the connector with its credentials under **Custom OAuth client** in
the add-connector form. The same works by hand in a config file. Gmail,
for example, needs your own Google Cloud OAuth client; once you have it,
add it to a config file as:

```json
{
  "mcpServers": {
    "gmail": {
      "url": "https://gmailmcp.googleapis.com/mcp/v1",
      "oauth": {
        "clientId": "…",
        "clientSecret": "…",
        "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
        "redirectUri": "http://localhost:19876/callback"
      }
    }
  }
}
```

## Behaviour

- All configured servers are exposed through a single `mcp` proxy tool
  (search / describe / call), so the model's tool surface stays small no
  matter how many servers are configured.
- Servers connect lazily on first use and disconnect after an idle
  timeout; reconnects are automatic.
- Room tool policy and the permissions extension allow the `mcp` proxy tool on both
  the web and CLI surfaces; which servers it can reach is governed
  entirely by the config files above.
- The proxy tool's description lists every configured server (including
  never-connected ones as "not connected yet"), so the model always
  knows which connectors exist without any prompt changes.
- The adapter's direct-tools/pinning feature (`directTools` in config)
  is not active in exxperts rooms: room permissions admit only the
  `mcp` proxy, on the web and the CLI alike. Rooms always use the
  proxy; pinned entries are ignored harmlessly.
- Existing outbound content-policy scanning still runs before MCP tool
  calls.
- MCP sampling (a server asking the model to complete text) stays
  disabled in headless sessions unless explicitly auto-approved in
  config.
