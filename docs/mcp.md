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
same merged server list (each connector's status, address or command,
sign-in or key, tools and rooms) and manages it:
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
session start, most changes apply the next time a room is entered or
resumed. Removing a connector applies at once: its running calls stop, its
waiting questions close with nothing sent, and its connection and program
end in every conversation. A tool a connector adds while connected shows up
without reopening the room.

A program on this computer is added from the command you paste from its
setup instructions. exxperts reads that command itself, as one program and
its words, so a line with `|`, `&&` or `;` outside quotes is refused;
settings written in front of it, or under **Settings it needs (optional)**,
are handed to the program when it starts. They are kept, with the keys you
type, in `~/.exxperts/agent/mcp.json`, which on a Mac and on Linux only your
own account can read.

The page also includes a **directory** of verified connectors
(`apps/web-ui/src/connector-catalog.ts`): open servers that work with no
login, one-click OAuth servers (dynamic client registration verified),
and token-based servers (GitHub: paste an API token once).

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
- Servers connect on first use, or as a room opens, and disconnect after
  an idle timeout; reconnects are automatic.
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
- Each tool of a connector has a choice of three, on the connector's own
  page in Settings, Connectors: **Always allow** runs it without asking,
  **Ask first** asks every time, and **Blocked** never runs it. A choice
  counts in every room where the connector is on, also when you're away.
  The page lists the tools that read the connector's resources too, and a
  tool switched off by hand in the connector's file (`excludeTools`) shows
  as Blocked. Over remote access the page shows the choices without
  changing them.
- A tool with nothing chosen goes by what the connector says about it: it
  runs without asking when the connector marks it read-only
  (`readOnlyHint: true`, and not `destructiveHint: true`) or when it is a
  plain resource read, and asks first otherwise. **Use default** in the
  tool's menu clears a choice. Nothing changes for a tool until you pick
  something.
- Asking first happens in the panel above the message box, and shows what
  the room would send, with hidden characters written out. **Allow this
  time** runs it once. At the computer, **Always allow** sets that tool's
  choice, for every room where the connector is on; on a phone it counts
  as this time.
- Always allow is kept for where the connector is: its web address, or for
  a program its command, arguments, working folder and settings. When that
  changes, the tool asks again, and so does one that was read-only when
  you allowed it and no longer is. Changing a connector's address takes
  its Always allows back; Ask first and Blocked stay. Removing a connector
  removes its choices, so one added later under the same name starts with
  none.
- A tool allowed for one room before these choices existed still runs
  without asking in that room, until you pick a choice for it; picking one
  takes that room's yes back. Room settings, Connectors lists those that
  are left, each with Remove.
- A room on **Auto** with protection off doesn't ask first: a tool set to
  Ask first runs there too, and only Blocked stops it. A room on **Semi**,
  or on Auto with protection on, gets the question as any other.
- With nobody there to answer, as in a scheduled run, when the person
  left, or when a view-only phone takes over, a tool that would ask is
  refused, and a note stays in the conversation. A blocked tool is refused
  with no note, and its step says it didn't run.
- If the file with your choices can't be read, every tool asks first, a
  read-only one too, no connector can be removed, and the connector's page
  says so. **Reset choices** there, after you confirm, keeps that file
  beside it under another name and puts every tool of every connector back
  to its default, so a tool you blocked is no longer blocked. A file
  written by a newer version of exxperts is never reset: update exxperts.
- These marks are the connector's own word about its own tools, and a
  connector you added by hand counts the same as one from the directory.
  They guard against a fooled model, not a dishonest connector.
- Connectors run outside a room's protection, with your rights
  ([Folders, commands and protection](workspace-and-bash.md#what-protection-doesnt-cover)).
  A local connector whose program, package or working folder sits where a
  room can change files doesn't start.
- **Stop** stops a running connector call at once: the connector is asked to
  stop, and may already have done part of the work. A call is also stopped
  when the connector sends nothing for 5 minutes, or once it has run for an
  hour, and its step says so.
- When a connector asks for details while one of its tools runs, the room
  shows one card with every field, **Send** and **Not now**, and the line
  "What you send goes to" the connector. If the connector stops waiting,
  nothing is sent.
- MCP sampling (a server asking the model to complete text) is off.
  exxperts doesn't offer it to a connector, and a request a connector
  sends anyway is refused.
- A connector may give instructions for its use when it connects. The
  assistant gets them, cut at 4,096 characters, for the connectors that are
  on in its room, so they go to your AI provider with the conversation. A
  room may connect its connectors as it opens, to read them.
