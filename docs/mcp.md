# MCP client support

exxperts connects to MCP servers through the `mcp` extension, which is
backed by [pi-mcp-adapter](https://pi.dev/packages/pi-mcp-adapter).

## Transports

- **stdio**: local servers spawned as subprocesses.
- **HTTP**: remote servers over StreamableHTTP, with SSE fallback.
- **OAuth**: servers requiring browser login (`bearer` tokens or full
  OAuth flows). Connect from the connector's row under Settings,
  Connectors.

## Config

Servers are read from these files, merged in precedence order:

1. `~/.config/mcp/mcp.json`: shared user-global config (same file other
   MCP-capable tools use)
2. `~/.exxperts/agent/mcp.json`: exxperts user-global config

A room, in the app or in a scheduled run, reads only these two: its
connectors are the ones in your own settings. Project files such as
`.mcp.json` and `.pi/mcp.json` in a workspace folder are not read.

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

The previous config location, `~/.exxperts/app/mcp.json`, is no longer
read; move server entries into one of the files above.

In the app, the **Connectors** page (Settings, Connectors) shows the
same merged server list (each server's transport, which config file it
came from, its cached tools, and OAuth credential state) and manages it:
add/remove servers (saved to the exxperts user config), change a custom
web connector's address, check a connection, and run OAuth sign-ins (the
sign-in opens a browser on this machine, since the server runs locally).
The form's Name is free text: the server's key is made from it (lower case,
spaces to dashes, `-2` when taken), so room access and the saved sign-in
never move, and the name as typed is kept as `displayName` in the entry when
it differs from that key. A new address on the same site keeps the sign-in,
key and extra headers; another site drops them all and asks for the key
again. Rooms keep their access either way. Backed by `GET /api/mcp/status`
and the `/api/mcp/servers` routes. Because sessions read MCP config at
session start, changes apply the next time a room is entered or resumed.

The page also includes a **directory** of verified connectors
(`apps/web-ui/src/connector-catalog.ts`): open servers that work with no
login, one-click OAuth servers (dynamic client registration verified),
token-based servers (GitHub: paste an API token once), OAuth-app servers
(HubSpot: create an app in the provider's developer settings, then the
card opens the custom form with the Your own sign-in app fields prefilled),
and guided entries for providers that require your own credentials.

Servers that expect their key in a header of their own (for example
`X-Api-Key`) are added under **Extra headers** in the add-connector form,
instead of or next to the key. The headers are sent with every
request. A header named Authorization, or with api key, token or secret
as a word in its name (`X-Api-Key`, `X-Auth-Token`), is taken as the
sign-in and switches off the automatic OAuth login for that connector. In a config file the same is a `headers` object on the server
entry, with `"auth": false` when the header is the sign-in:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "auth": false,
      "headers": { "X-Api-Key": "your-key" }
    }
  }
}
```

Providers whose auth servers do not support dynamic client registration
(HubSpot is one; most enterprise identity providers are configured this
way) fail the one-click login with "does not support dynamic client
registration". For those, create an app in the provider's developer
settings with the redirect URL `http://localhost:19876/callback`, then
add the connector with its credentials under **Your own sign-in app** in
the add-connector form. The same works by hand in a config file. Gmail,
for example, needs your own Google Cloud OAuth client, with “Use this
client for an AI-powered agent” selected on it; once you have it, add it
to a config file as:

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
- Room tool policy and the permissions extension allow the `mcp` proxy tool;
  which servers it can reach is governed entirely by the config files
  above.
- The proxy tool's description lists every configured server (including
  never-connected ones as "not connected yet"), so the model always
  knows which connectors exist without any prompt changes.
- The adapter's direct-tools/pinning feature (`directTools` in config)
  is not active in exxperts rooms: room permissions admit only the
  `mcp` proxy. Rooms always use the
  proxy; pinned entries are ignored harmlessly.
- Existing outbound content-policy scanning still runs before MCP tool
  calls.
- A tool runs without asking when the connector marks it read-only
  (`readOnlyHint: true`, and not `destructiveHint: true`), when it is a
  plain resource read, or when you allowed it for the room. Anything
  else asks first, in the panel above the message box, and shows what
  the room would send, with hidden characters written out. **Allow this
  time** runs it once. At the computer, a web connector's tool that
  isn't marked destructive also offers **Allow for this room**: the room
  then uses that tool without asking, also in a scheduled task and when
  you're away. It isn't offered on a phone, or for a connector that is a
  program on this computer. Room settings, Connectors lists the tools
  you allowed, each with Remove. A room on **Semi** or **Auto** gets the
  question too: those modes are about commands and websites.
- With nobody there to answer, as in a scheduled run, when the person
  left, or when a view-only phone takes over, a tool you haven't allowed
  for the room is refused, and a note stays in the conversation.
- This goes by what each connector says about its own tools, and a
  connector you added by hand counts the same as one from the directory.
  A connector that marks nothing asks every time, unless you allowed
  that tool for the room. The marks guard against a fooled model, not a
  dishonest connector.
- A connector's own app page, once opened, calls its tools outside the
  room's card.
- Connectors run outside a room's protection, with your rights
  ([Folders, commands and protection](workspace-and-bash.md#what-protection-doesnt-cover)).
  A local connector whose program, package or working folder sits where a
  room can change files doesn't start.
- MCP sampling (a server asking the model to complete text) stays
  disabled in headless sessions unless explicitly auto-approved in
  config.
