# How exxperts works

> Read this after the [README](../README.md) to understand what the
> product actually is and how its pieces fit. For contributor setup and
> commands, see the [developer guide](developer.md).

## The product in one paragraph

exxperts is a local-first platform for **persistent AI colleagues**. Rooms
are where you work with them, and they replace traditional chats: a room is
a durable place where you set up the tools, folders, connections, and skills
for your interactions, and the *exxpert* living in it is the colleague you
talk to, with its own identity and durable, human-governed memory. You work
with it over weeks, not sessions. The core of the product is
not chat; it is the **memory engine**: an approval-gated lifecycle
(Remember → Memorize → Review) that turns conversations into durable,
auditable memory the agent boots from next time. Chat orbits the memory
engine, not the other way around.

Everything runs on your machine: the web server binds to localhost
only (with an off-by-default remote mode for your own paired devices
over your private tunnel, see `SECURITY.md`), state lives under
`~/.exxperts/`, and no memory changes without
your explicit approval.

## Lineage

exxperts is a hard fork of the open-source
[Pi](https://github.com/badlogic/pi-mono) coding agent (v0.70.5, MIT).
The fork lives in `runtime/` as `@exxeta/exxperts-*` workspace packages
and provides sessions, model providers, tools, and extensions. The
product layer (persistent rooms, the memory engine, the web app) is
built on top in `apps/` and `pi-package/`.

## Surfaces

| Surface | Command | What it is |
| --- | --- | --- |
| Web app | `exxperts web` | The primary product: persistent rooms with the full memory lifecycle. |
| CLI/TUI | `exxperts cli` | The coding workspace (ExxCode) with repo access; rooms are also reachable from the CLI. |

## Anatomy of a room: four prompt layers

A room's system prompt is assembled from four layers (in
`apps/web-server/src/persistent-agents.ts`), ordered deliberately:
primacy for identity, recency for runtime state.

| Layer | Content | Ownership | Updates |
| --- | --- | --- | --- |
| **L0**, platform kernel | Identity, privacy, style rules | Code | Auto-ships with every release |
| **L1a**, constitution | Per-agent charter and mode preset, versioned | Scaffolded at creation | Explicit migration path (see [`l1a-constitution-upgrade.md`](l1a-constitution-upgrade.md)) |
| **L1b**, durable memory | The agent's long-term memory file | **User-governed** | Only through approved memory workflows |
| **L2**, runtime envelope | Session metadata, workspace grants | Code | Auto-ships; read last |

L1b is the layer that grows. L0, L1a, and L2 are kept deliberately lean
so a fresh room starts with a small prompt and the memory budget belongs
to actual memory.

## L1b: the memory file

Each room owns one Markdown file (`L1b/current.md`), readable by you,
with four fixed sections:

- **Chronos**: a concise temporal spine of the room's history.
- **Notes**: lasting understanding, grouped by topic. Every note carries
  a hidden line with its id, the day it was saved, whether it is pinned
  and the conversation it came from; the room reads the notes without
  that line.
- **Open items**: unresolved loops worth carrying forward.
- **Waiting conversations**: the conversations you remembered but have
  not yet memorized, newest last.

Notes that leave memory go to the archive beside the file
(`L1b/archive/entries.md`), each with the reason it left; the room can
read its archive on demand.

## The memory lifecycle

Three workflows move material through that file. Each follows the same
contract: an isolated worker **proposes**, the human **approves**, the
system **writes**, never the worker.

### Remember: end of a work session

Freezes the active thread and asks a compression worker to distill it
into a proposed summary of the conversation. The default Remember button
runs a fast path at standard density and shows you the proposal before
it is saved; a room can be set to apply warning-free proposals without
that preview. "Remember with options…" opens the full flow, where you
choose a density (compact/standard/rich) and can add an optional
steering note. Things
you explicitly asked the agent to remember are carried through and
become pinned notes when the conversation is memorized. The worker prompt is measured against
the model's context window before the call; oversized transcripts are
reduced with declared elisions (never silently truncated) or refused
with guidance. On approval, the summary joins the waiting conversations, the thread closes at
a clean boundary, and the previous memory file is archived. Remember
warns when one more save would fill the room's waiting list; the
budget behavior behind that is in [`memory.md`](memory.md).

### Memorize (absorb): consolidating the buffer

Once conversations are waiting, Memorize reads them *in chronological
order* (later conversations supersede earlier ones), one at a time: for
each, a worker proposes a short list of changes to the notes (add,
update, supersede, close an open item, or let the conversation go with
a reason), the system applies them to a working copy and fills in the
ids, dates and provenance. Anything you asked the room to remember
becomes a pinned note. The goal is memory that gets **denser, not
merely larger**. You see a first read, can discuss it, and the card
shows what each conversation added or changed before you save. The
memory budget is the system's own arithmetic on the result: what would
not fit is listed for the archive, and you keep, raise or save
([`memory.md`](memory.md)).

### Review: tightening stable memory

Review works on the notes and open items (Chronos and the waiting
conversations are withheld and grafted back byte-exact), and it works
on notes rather than on prose: every note is addressable, so a review is a
short list of operations against notes named by id, a group of topics
at a time. That is what keeps a tidy honest — a note nobody names is
never touched, so ids, saved-on dates and pins survive by construction;
a pinned note may be worded better and nothing else; an update or merge
whose text outgrows what it replaced is refused, so "tidy" can never
mean "write more"; and nothing is deleted, because the archive is the
only exit and every row carries the reason it left. A group whose call
fails costs that group alone, named on the card. The room's memory
budget is the server's own arithmetic after the tidy — by rank,
disclosed and reversible — and nothing is written until you approve
([`memory.md`](memory.md)).

### Safety rails

- Workers are ephemeral, **tool-less**, isolated model sessions with
  locked models; they cannot touch files or the network.
- Every proposal is `writesMemory: false`; only the approval endpoint
  writes, after fingerprint checks detect any staleness between
  proposal and approval.
- Every write archives the prior L1b (copy-on-write) and records an
  event with SHA-256 fingerprints, so history is reconstructable.

See [`memory.md`](memory.md) for the user-facing walkthrough.

## Models and AI profiles

A global **AI profile** (Claude, ChatGPT Plus/Pro, or a local
OpenAI-compatible gateway) maps each LLM process to an allowed model:
rooms pick from the profile's room-model list, Remember workers
inherit the room's model, and Memorize/Review use the profile's
maintenance model. The mapping is asserted at call time, so a room
cannot silently run on an off-profile model. Setup is described in
[`provider-setup.md`](provider-setup.md).

## Tools and the workspace

Rooms get tools through a per-room policy rather than a global grant:

- **Workspace**: two access modes over the same toolset. **Full
  access** works with files like you do, in the chosen folder and
  beyond. **Bounded workspace** carries the same Read, List, Find,
  Search, Write and Edit tools fenced to one folder: the folder is
  re-verified against its fingerprint on every use (a swapped or
  redirected folder is refused), protected files (secrets, keys,
  `.git`) stay untouchable and a custom protected list adds to the
  built-ins rather than replacing them, and Search runs on ripgrep
  with a guarded built-in fallback. Each tool is a toggle; whether a
  room can change files follows from the tools you enabled, and a room
  with no write tools and no Bash says it is read-only
  ([`workspace-and-bash.md`](workspace-and-bash.md)).
- **Bash**: Full access only, off by default. Each command shows an
  approval card with the exact command before it runs; the "Bash:
  asks" / "Bash: auto" chip in the chat header switches a room to run
  without asking, and auto can only be enabled at the computer, never
  from a remote device. Rooms that had Bash before the card existed
  were switched to auto once, at upgrade, so their behavior did not
  change; every room since starts at asks.
- **`fetch_url`**: HTTP fetching with SSRF defenses (private-range and
  redirect protection).
- **Web search**: built in via DuckDuckGo; local SearXNG is the reliable path for heavy use or networks where DuckDuckGo blocks automated queries ([`web-search.md`](web-search.md)).
- **Files**: documents and outputs a room or its specialists produce,
  viewable in a sandboxed file viewer; delegated tasks a room runs
  live in the room's Files panel, with a click-to-watch run view. PDFs
  and Word documents are read through an isolated parser, with page
  counts noted and offset/limit paging like any text file; a scanned
  PDF with no text layer is called out honestly instead of returning
  nothing. An `.xlsx` added to Files is previewed as a readable table
  (the legacy `.xls` format stays refused).
- **`read_skill`**: rooms read the skills enabled for them through this
  tool; skills are the sanctioned way to give rooms new instructions
  (extensions never load in rooms). The library lists skills from the
  exxperts store and from the cross-tool `~/.agents/skills` directory
  shared with other agent tools (read-only on our side); wherever a
  skill lives, a room only uses it after you review and enable it
  there, and an edited skill must be re-reviewed.
- **Consult**: a room can ask another room a question via @-mention in
  chat; the consulted room answers read-only from its own memory and
  context.
- **MCP**: external MCP connectors ([`mcp.md`](mcp.md)).
- **Schedules**: recurring background prompts with preflight checks
  and run history.

Tool permissions are checked and explained per call, and the bounded
fence is enforced: a tool that is supposed to be blocked fails the
session loudly instead of slipping through. None of it is an OS
sandbox; the security boundary is the localhost-only server and your
approval gates, not process isolation.

Where your file goes: when you attach a file to a room, it is stored
on your machine under that room's own folder; it is not uploaded
anywhere. The room can read it, and files you attach or the room
creates show up in the room's Files panel, where you can download or
delete them.

## Security posture

- The web server binds to `127.0.0.1` only (no LAN exposure; remote
  mode, off by default, additionally serves your own paired devices
  over your private tunnel),
  validates Host/Origin headers against DNS rebinding, and requires a
  client auth token on API and WebSocket requests (see `SECURITY.md`).
- Durable memory has no silent write path: every mutation goes through
  the proposal/approval workflow and a server-side fingerprint check.
  Warning-free proposals from an action you triggered can apply
  automatically; anything questionable always comes back for a manual
  approval screen.
- State directories are created with restrictive modes under
  `~/.exxperts/`.

## Where state lives

| Path | Purpose |
| --- | --- |
| `~/.exxperts/app/personalized-agents/<id>/` | Each room: L1b memory, archives, event records, threads |
| `~/.exxperts/app/conversations/` | Web conversation history |
| `~/.exxperts/app/persistent-room-schedules/`, `background-runs/` | Schedules and their run history |
| `~/.exxperts/app/usage.jsonl` | Token/cost usage log |
| `~/.exxperts/app/web-search.json`, `searxng/` | Web-search configuration |
| `~/.exxperts/agent/` | Embedded runtime state: provider auth, model registry, CLI sessions |
